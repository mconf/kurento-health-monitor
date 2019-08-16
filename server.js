'use strict';

const config = require('config');
const mediaServerClient = require('kurento-client');
const Logger = console;
const http = require('https');
const url = require('url');
const os = require('os');

const KMS_ARRAY = config.get('kurento');
const KMS_FAIL_AFTER = 5;
const NOF_STARTUP_CONNECTION_RETRIES = config.has('kurentoStartupRetries')
  ? config.get('kurentoStartupRetries')
  : Infinity;
const HOST_RETRY_TIMER = 3000;
const KMS_FAILOVER_TIMEOUT_MS = 15000;
const WEBHOOK_URL = config.get('webhookURL');
const HOST_NAME = config.has('hostAddress')? config.get('hostAddress') : os.hostname();

let instance = null;

class Monitor {
  constructor () {
    if (instance == null) {
      this.hosts = [];
      this._reconnectionRoutine = {};
      instance = this;
    }
    return instance;
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

  static connectToHost (url, ip) {
    const connect =  new Promise((resolve, reject) => {
      mediaServerClient(url, {failAfter: KMS_FAIL_AFTER}, (error, client) => {
        if (error) {
          return reject(error);
        }
        const newHost = {
          id: Monitor.greatRandomToken(12),
          url,
          ip,
          medias: {
            'main': 0,
            'content' : 0,
            'audio' : 0,
          },
          client: client
        };
        return resolve(newHost);
      });
    });

    const failOver = new Promise((resolve, reject) => {
      setTimeout(reject, KMS_FAILOVER_TIMEOUT_MS, 'connectionTimeout');
    });

    return Promise.race([connect, failOver]);
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
