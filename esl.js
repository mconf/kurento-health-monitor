const { Connection } = require('modesl');
const Logger = console;
const config = require('config');

const RECONNECTION_TIMER = 5000;
const HOST_NAME = config.has('hostAddress')? config.get('hostAddress') : os.hostname();
const LOG_PREFIX = '[esl]';
const ESL_EVENTS = {
  END: "esl::end",
  DISCONNECT_NOTICE: "esl::events::disconnect::notice",
};


/**
 * @classdesc
 * This class is a an Event Socket Listener for FreeSWITCH
 * @memberof mcs.adapters
 */
class EslWrapper {

  /**
   * Create a  new EslWrapper Instance
   * @param {Object} params Event Socket Listener params
   */
  constructor (params, emitHookWarning) {
    this.params = params;
    this.connected = false;
    this.error = {};
    this.emitHookWarning = emitHookWarning;
    this.failureNotified = false;

    this._client = null;
    this._clientOptions = {
      host: (this.params && this.params.host) ?
        this.params.host : ESL_IP,
      port: (this.params && this.params.port) ?
        this.params.port : ESL_PORT,
      auth: (this.params && this.params.auth) ?
        this.params.auth : ESL_PASS,
    };
  }

  /**
   * ESL Parameters
   * @type {Object}
   */
  get params () {
    return this._params;
  }

  set params (params) {
    this._params = params;
  }

  _connect () {
    this._client = new Connection(
      this._clientOptions.host,
      this._clientOptions.port,
      this._clientOptions.auth,
      this._onConnected.bind(this)
    );

    this._client.auth((error) => {
      if (error) {
        Logger.error(LOG_PREFIX, `FreeSWITCH ESL connection authentication error`);
        this._onDisconnection()
      }
    });
  }

  _monitorESLClientConnectionErrors () {
    this._client.on('error', (error) => {
      if (error) {
        Logger.error(LOG_PREFIX, `FreeSWITCH ESL connection received error ${error.code}`);
        this._onDisconnection();
      }
    });
  }

  /**
   * Start ESL, connecting to FreeSWITCH
   * @return {Promise} A Promise for the starting process
   */
  start () {
    try {
      this._connect();
      this._monitorESLClientConnectionErrors();
      } catch (error) {
        Logger.error(LOG_PREFIX, `Error when starting ESL interface`,
          { error });
    }
  }

  /**
   * Stop ESL
   * @return {Promise} A Promise for the stopping process
   */
  async stop () {
    try {
      if (this._client && typeof(this._client.end) == 'function') {
        this._client.end();
        this._client = null;
      }
    } catch (error) {
      throw (error);
    }
  }

  _onConnected () {
    Logger.info(LOG_PREFIX, `Connected to FreeSWITCH ESL`);

    if (this._reconnectionRoutine) {
      clearInterval(this._reconnectionRoutine);
      this._reconnectionRoutine = null;
    }

    this._client.subscribe([
      'all'
    ], this._onSubscribed.bind(this));
  }

  _onDisconnection () {
    if (this._reconnectionRoutine == null) {
      Logger.error(LOG_PREFIX, `FreeSWITCH ESL connection dropped unexpectedly`);

      if (!this.failureNotified) {
        try {
          this.emitHookWarning(`${HOST_NAME} triggered MEDIA_SERVER_OFFLINE for FreeSWITCH at ${this._clientOptions.host}:${this._clientOptions.port}`);
        } catch (e) {
          Logger.error('Error on hook notify', e);
        }
        this.failureNotified = true;
      }

      this._reconnectionRoutine = setInterval(async () => {
        try {
          this.stop();
          this._connect();
          this._monitorESLClientConnectionErrors();
        } catch (error) {
          Logger.warn(LOG_PREFIX, `Failed to reconnect to ESL, try again in ${RECONNECTION_TIMER}`,
            { error });
          this.stop();
        }
      }, RECONNECTION_TIMER);
    }
  }

  _onSubscribed () {
    this._client.on(ESL_EVENTS.DISCONNECT_NOTICE, this._onDisconnection.bind(this));
    this._client.on(ESL_EVENTS.END, this._onDisconnection.bind(this));

    this.connected = true;

    if (this.failureNotified) {
      this.emitHookWarning(`${HOST_NAME} triggered MEDIA_SERVER_ONLINE for FreeSWITCH at ${this._clientOptions.host}:${this._clientOptions.port}`);
      this.failureNotified = false;
    }
  }

  //check if body has error message
  _hasError(body) {
    return body.startsWith("-ERR");
  }
}

module.exports = EslWrapper;
