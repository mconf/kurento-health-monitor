'use strict';

const config = require('config');
const mediaServerClient = require('kurento-client');
const Logger = console;
const http = require('https');
const url = require('url');
const os = require('os');
const EslWrapper = require('./esl.js');
const WebSocket = require('ws');

const KMS_ARRAY = config.get('kurento');
const KMS_FAIL_AFTER = 5;
const NOF_STARTUP_CONNECTION_RETRIES = config.has('kurentoStartupRetries')
  ? config.get('kurentoStartupRetries')
  : Infinity;
const HOST_RETRY_TIMER = 3000;
const KMS_FAILOVER_TIMEOUT_MS = 15000;
const WEBHOOK_URL = config.get('webhookURL');
const HOST_NAME = config.has('hostAddress')? config.get('hostAddress') : os.hostname();
const CONNECTION_HEALTH_CHECK_INTERVAL = config.has('connHealthCheckInterval')
  ? config.get('connHealthCheckInterval')
  : '30000';
const ENABLE_HEALTHCHECK = config.has('enableConnHealthcheck')
  ? config.get('enableConnHealthcheck')
  : false;

const MONITOR_FS = config.get('freeswitch.enabled');
const ESL_PARAMS = {
  host: (config.has('freeswitch.eslIP')
    ? config.get('freeswitch.eslIP')
    : '127.0.0.1'),
  port: (config.has('freeswitch.eslPort')
    ? config.get('freeswitch.eslPort')
    : '8021'),
  auth: (config.has('freeswitch.eslPassword')
    ? config.get('freeswitch.eslPassword')
    : 'ClueCon'),
  sipWssUrl: (config.has('freeswitch.sipWssUrl')
    ? config.get('freeswitch.sipWssUrl')
    : undefined),
};

let instance = null;

class Monitor {
  constructor () {
    if (instance == null) {
      this.hosts = [];
      this.esl;
      this._reconnectionRoutine = {};
      instance = this;
    }
    return instance;
  }

  monitorFreeSWITCH () {
    this.esl = new EslWrapper(ESL_PARAMS, this.emitHookWarning);
    this.esl.start();
  }

  async startHosts () {
    const processHosts = async () => {
      const tryToConnect = async (host) => {
        const { url, ip, retries } = host;
        if (retries < NOF_STARTUP_CONNECTION_RETRIES) {
          if (!this._hostStarted(url, ip)) {
            try {
              const newHost = await Monitor.connectToHost(url, ip);
              this._monitorConnectionState(newHost);
              this.addHost(newHost);
              if (host.startupFailureNotified) {
                host.startupFailureNotified = false;
                this.emitHookWarning(`${HOST_NAME} triggered STARTUP_CONNECT_SUCCESS for Kurento ${host.url} ${host.ip}`);
              }
              if (ENABLE_HEALTHCHECK) {
                this.healthcheck(newHost);
              }
            }
            catch (e) {
              host.retries++;
              Logger.error(`[monitor] Failed to connect to candidate host ${JSON.stringify({ url, ip, retries})}`);
              if (!host.startupFailureNotified) {
                this.emitHookWarning(`${HOST_NAME} triggered STARTUP_CONNECT_FAILURE for Kurento ${host.url} ${host.ip}`);
                host.startupFailureNotified = true;
              }
              setTimeout(() => tryToConnect(host), HOST_RETRY_TIMER);
            };
          }
        } else {
          Logger.error(`[monitor] Maximum number of retries expired for host ${url} ${ip}`);
        }
      };

      const tentativeHosts = KMS_ARRAY.map(th => { return { ...th, retries: 0}});

      tentativeHosts.forEach(tentativeHost => {
        tryToConnect(tentativeHost);
      });
    }

    processHosts();
  }

  static connect (url, ip) {
    return new Promise((resolve, reject) => {
      mediaServerClient(url, {failAfter: KMS_FAIL_AFTER}, (error, client) => {
        if (error) {
          if (client && client.close) {
            client.close()
          }
          return reject(error);
        }
        const newHost = {
          id: Monitor.greatRandomToken(12),
          url,
          ip,
          client: client
        };
        return resolve(newHost);
      });
    });
  }

  static connectToHost (url, ip) {
    const failOver = new Promise((resolve, reject) => {
      setTimeout(reject, KMS_FAILOVER_TIMEOUT_MS, 'connectionTimeout');
    });

    return Promise.race([Monitor.connect(url, ip), failOver]);
  }

  static probeConnectionHealth(url) {
    return new Promise((resolve, reject) => {
      let ws = new WebSocket(url, { handshakeTimeout: KMS_FAILOVER_TIMEOUT_MS });

      const destroyWs = () => {
        ws.close();
        ws = null;
      };

      const removeWsListeners = () => {
        ws.removeAllListeners('close');
        ws.removeAllListeners('error');
        ws.removeAllListeners('open');
      };

      const onClose = (code, reason) => {
        console.error(`[monitor] Connection healthcheck: WS closed prematurely code=${code} reason=${reason}`);
        removeWsListeners();
        destroyWs();
        return reject(reason);
      };

      const onOpen = () => {
        const ping = {
          id: 1,
          method: "ping",
          params: {
            interval: KMS_FAIL_AFTER * 1000,
          },
          jsonrpc: "2.0"
        }

        ws.on('message', (data = {}) => {
          const pong = JSON.parse(data);
          const { result, id } = pong;
          if (id === ping.id && result && result.value === 'pong') {
            removeWsListeners();
            destroyWs();
            return resolve();
          }
        });

        ws.send(JSON.stringify(ping));
      };

      const onError = (error) => {
        console.error(`[monitor] Connection healthcheck: WS conn error`, { error });
        removeWsListeners();
        destroyWs();
        return reject(error);
      };

      ws.once('open', onOpen);
      ws.once('close', onClose);
      ws.once('error', onError);
    });
  }

  addHost (host) {
    if (host) {
      const { id } = host;
      this.removeHost(id);
      this.hosts.push(host);
      Logger.info('[monitor] Available hosts =>', JSON.stringify(this.hosts.map(h => ({ url: h.url, ip: h.ip }))));
      return;
    }

    Logger.warn("[monitor] Undefined media server host, should not happen");
  }

  removeHost (hostId) {
    this.hosts = this.hosts.filter(host => host.id !== hostId);
  }

  _hostStarted (url, ip) {
    return this.hosts.some(h => h.url == url && h.ip == ip);
  }

  _monitorConnectionState (host) {
    const { id, client, url, ip } = host;
    try {
      Logger.debug('[monitor] Monitoring connection state for host', id, 'at', url);
      client.on('disconnect', () => {
        this._onDisconnection(host);
      });
      client.on('reconnected', (sameSession) => {
        this._onReconnection(sameSession, host);
      });
    }
    catch (err) {
      Logger.error('[monitor] Error on monitoring host', id, err);
    }
  }

  _onDisconnection (host) {
    try {
      const { client, id, url, ip } = host;
      Logger.error('[monitor] Host', id, 'was disconnected for some reason, will have to clean up all elements and notify users');
      this.removeHost(id);
      if (!host.failureNotified) {
        try {
          this.emitHookWarning(`${HOST_NAME} triggered MEDIA_SERVER_OFFLINE for Kurento ${url} ${ip}`);
        } catch (e) {
          Logger.error('Error on hook notify', e);
        }
        host.failureNotified = true;
      }

      // Reset host media tracking
      host.audio = 0;
      host.video = 0;

      this._reconnectToServer(host);
    } catch (e) {
      Logger.error('[monitor] Error trying to handle host disconnection', e);
    }
  }

  _onReconnection (sameSession, host) {
    if (!sameSession) {
      Logger.warn('[monitor] Media server reconnected, but it is not the same session');
      this._onDisconnection(host);
    } else {
      if (host.failureNotified) {
        this.emitHookWarning(`${HOST_NAME} triggered MEDIA_SERVER_ONLINE for Kurento ${url} ${ip}`);
        host.failureNotified = false;
      }
    }
  }

  _reconnectToServer (host) {
    const { client, id, url } = host;
    Logger.info("[monitor] Reconnecting to host", id, url);
    if (this._reconnectionRoutine[id] == null) {
      this._reconnectionRoutine[id] = setInterval(async () => {
        try {
          const connect =  new Promise((resolve, reject) => {
            mediaServerClient(url, {failAfter: KMS_FAIL_AFTER}, (error, client) => {
              if (error) {
                return reject(error);
              }
              host.client = client;
              return resolve(host);
            });
          });

          const failOver = new Promise((resolve, reject) => {
            setTimeout(reject, KMS_FAILOVER_TIMEOUT_MS, 'connectionTimeout');
          });

          Promise.race([connect, failOver]).then(h => {
            this._monitorConnectionState(host);
            clearInterval(this._reconnectionRoutine[id]);
            delete this._reconnectionRoutine[id];
            this.addHost(h);
            Logger.warn("[media] Reconnection to media server succeeded", id, url);
            if (h.failureNotified) {
              this.emitHookWarning(`${HOST_NAME} triggered MEDIA_SERVER_ONLINE for Kurento ${h.url} ${h.ip}`);
              host.failureNotified = false;
            }

          }).catch(e => {
            Logger.info("[monitor] Failed to reconnect to host", id);
          });
        } catch (err) {
          Logger.info("[monitor] Failed to reconnect to host", id);
        }
      }, HOST_RETRY_TIMER);
    }
  }

  emitHookWarning (text) {
    const opts = url.parse(WEBHOOK_URL);
    const data = { text };
    opts.headers = {};
    opts.headers['Content-Type'] = 'application/json';
    opts.method = 'POST';

    Logger.info(`[monitor] Notifying hook about ${text}`);
    http.request(opts, (res) => {
      Logger.info(`[monitor] Hook notified about ${text}`);
    }).end(JSON.stringify(data));
  }

  healthcheck (host) {
    if (host.healthcheckerInterval) return;
    const { url, ip } = host;
    Logger.info(`[monitor] Starting connection healthchecker for host url=${url} ip=${ip}`);
    host.healthcheckerInterval = setInterval(async () => {
      try {
        await Monitor.probeConnectionHealth(url);

        if (host.healthcheckFailureNotified ) {
          host.healthcheckFailureNotified = false;
          this.emitHookWarning(`${HOST_NAME} triggered WS_CONN_HEALTHY for Kurento ${url} ${ip}`);
        }
      }
      catch (e) {
        Logger.error(`[monitor] Healthcheck FAILED for host ${JSON.stringify({ url, ip })}`);
        if (!host.healthcheckFailureNotified) {
          this.emitHookWarning(`${HOST_NAME} triggered WS_CONN_UNHEALTHY for Kurento ${host.url} ${host.ip}`);
          host.healthcheckFailureNotified = true;
        }
      };
    }, CONNECTION_HEALTH_CHECK_INTERVAL);
  }

  static greatRandomToken (size, base = 32) {
    let i, r,
      token = '';

    for( i=0; i < size; i++ ) {
      r = Math.random() * base|0;
      token += r.toString(base);
    }

    return token;
  }
}

const monitor = new Monitor();

monitor.startHosts();

if (MONITOR_FS) {
  monitor.monitorFreeSWITCH();
}

