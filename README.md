## Configuration
- `kurento`: an array of objects consisting of `kurento.ip` (Kurento's host IP) and `kurento.url` (Kurento WS URL).
  ```
  kurento:
    - ip: ""
      url: ws://HOST/kurento
  ```
 - `kurentoStartupRetries`: number of initial connection tries. Defaults to `Infinity`.
  
 - `webhookURL`: URL where the service will send `POST` requests notifying the media server's state.
 - `hostAddress`: this service's host identifier. Can be anything, it's just appended to the event strings.

## Events
  - `hostAddress` triggered MEDIA_SERVER_OFFLINE for Kurento `kurento.url` `kurento.ip`
  - `hostAddress` triggered MEDIA_SERVER_ONLINE for Kurento `kurento.url` `kurento.ip` (triggered only after `MEDIA_SERVER_OFFLINE`)
  - `hostAddress` triggered STARTUP_CONNECT_FAILURE for Kurento `kurento.url` `kurento.ip`
  - `hostAddress` triggered STARTUP_CONNECT_SUCCESS for Kurento `kurento.url` `kurento.ip` (triggered only after `STARTUP_CONNECT_FAILURE`)
