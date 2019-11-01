## Running

This was tested from Node.js 8.x to 12.x.

There is an example configuration file in `./config/default.example.yml`. The
file which the app looks for must be `./config/default.yml`, so be sure to copy
it over and configure it to your wish.
All the configuratin options have environment variables for them as well. Look
for the mapping in `./config/custom-environment-variables.yml`.

And then, to run:
- `npm install`
- `npm start` or `node server.js`

The application can also be run with docker. Look for the `Dockerfile` in the root
dir and have fun with it.

## Configuration

- `kurento`: an array of objects consisting of `kurento.ip` (Kurento's host IP) and `kurento.url` (Kurento WS URL).
  ```
  kurento:
    - ip: ""
      url: ws://HOST/kurento
  ```
 - `kurentoStartupRetries`: Integer. number of initial connection tries. Defaults to `Infinity`.
 - `enableConnHealthcheck`: Boolean. Enables a periodic health check (run every `connHealthCheckInterval`) which opens a WS connection with Kurento and then closes it. Defaults to `true`.
 - `connHealthCheckInterval`: Integer. Connection healthchecker interval, in ms. Defaults to `30000`.
 - `kurentoStartupRetries`: Integer. Number of initial connection tries. Defaults to `Infinity`.
 - `webhookURL`: String. URL where the service will send `POST` requests notifying the media server's state.
 - `hostAddress`: String. this service's host identifier. Can be anything, it's just appended to the event strings.

## Events
  - `hostAddress` triggered MEDIA_SERVER_OFFLINE for Kurento `kurento.url` `kurento.ip`
  - `hostAddress` triggered MEDIA_SERVER_ONLINE for Kurento `kurento.url` `kurento.ip` (triggered only after `MEDIA_SERVER_OFFLINE`)
  - `hostAddress` triggered STARTUP_CONNECT_FAILURE for Kurento `kurento.url` `kurento.ip`
  - `hostAddress` triggered STARTUP_CONNECT_SUCCESS for Kurento `kurento.url` `kurento.ip` (triggered only after `STARTUP_CONNECT_FAILURE`)
  - `hostAddress` triggered WS_CONN_UNHEALTHY for Kurento `kurento.url` `kurento.ip` (triggered only if `enableConnHealthcheck` = `true`)
  - `hostAddress` triggered WS_CONN_HEALTHY for Kurento `kurento.url` `kurento.ip` (triggered only if `enableConnHealthcheck` = `true` and after `WS_CONN_UNHEALTHY`)
