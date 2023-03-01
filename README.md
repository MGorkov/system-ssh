# system-ssh
A wrapper for system ssh with [SSH2](https://github.com/mscdex/ssh2) interface.

# Table of Contents

* [Requirements](#requirements)
* [Installation](#installation)
* [Client examples](#client-examples)
  * [Execute 'uptime' on a server](#execute-uptime-on-a-server)
  * [Send a raw HTTP request to port 80 on the server](#send-a-raw-http-request-to-port-80-on-the-server)
  * [Connection hopping](#connection-hopping)
* [Client events](#client-events)
* [Client methods](#client-methods)

## Requirements

* [node.js](http://nodejs.org/) -- v10.16.0 or newer
  * node v12.0.0 or newer for Ed25519 key support

## Installation
```shell
npm install system-ssh
```

## Client examples

### Execute 'uptime' on a server

```js
const { Client } = require('system-ssh');

const conn = new Client();
conn.on('ready', () => {
  console.log('Client :: ready');
  conn.exec('uptime', (err, stream) => {
    if (err) throw err;
    stream.on('close', (code, signal) => {
      console.log('Stream :: close :: code: ' + code + ', signal: ' + signal);
      conn.end();
    }).on('data', (data) => {
      console.log('STDOUT: ' + data);
    }).stderr.on('data', (data) => {
      console.log('STDERR: ' + data);
    });
  });
}).connect({
  host: '192.168.100.100',
  port: 22,
  username: 'test',
  identityFile: '/path/to/my/key'
});

// example output:
// Client :: ready
// STDOUT:  13:31:36 up 118 days,  4:02,  1 user,  load average: 1,82, 1,32, 1,34
//
// Stream :: close :: code: 0, signal: null
```

### Send a raw HTTP request to port 80 on the server

```js
const { Client } = require('system-ssh');

const conn = new Client();
conn.on('ready', () => {
  console.log('Client :: ready');
  conn.forwardOut('192.168.100.102', 8000, '127.0.0.1', 80, (err, stream) => {
    if (err) throw err;
    stream.on('close', () => {
      console.log('TCP :: CLOSED');
      conn.end();
    }).on('data', (data) => {
      console.log('TCP :: DATA: ' + data);
    }).end([
      'HEAD / HTTP/1.1',
      'User-Agent: curl/7.27.0',
      'Host: 127.0.0.1',
      'Accept: */*',
      'Connection: close',
      '',
      ''
    ].join('\r\n'));
  });
}).connect({
  host: '192.168.100.100',
  port: 22,
  username: 'test',
  identityFile: '/path/to/my/key'
});

// example output:
// Client :: ready
// TCP :: DATA: HTTP/1.1 200 OK
// Server: nginx/1.14.1
// Date: Tue, 28 Feb 2023 14:45:40 GMT
// Content-Type: text/html
// Content-Length: 871
// Last-Modified: Tue, 19 Jul 2022 15:07:04 GMT
// Connection: close
// ETag: "62d6c898-367"
// Accept-Ranges: bytes
//
//
//TCP :: CLOSED

```

### Connection hopping

```js
const { Client } = require('system-ssh');

const conn = new Client();
conn.on('ready', () => {
  console.log('Client :: ready');
  conn.exec('uptime', (err, stream) => {
    if (err) throw err;
    stream.on('close', (code, signal) => {
      console.log('Stream :: close :: code: ' + code + ', signal: ' + signal);
      conn.end();
    }).on('data', (data) => {
      console.log('STDOUT: ' + data);
    }).stderr.on('data', (data) => {
      console.log('STDERR: ' + data);
    });
  });
}).connect({
  host: '192.168.100.100',
  port: 22,
  username: 'test',
  identityFile: '/path/to/my/key',
  jumpHosts: '192.168.100.101'  
});

// example output:
// Client :: ready
// STDOUT:  21:57:11 up 344 days,  8:09,  7 users,  load average: 0,42, 0,38, 0,29
//
// Stream :: close :: code: 0, signal: null

```

### Client events

* **close**(code, signal) - master process was closed.

* **error**(< _Error_ >err) - an error occurred in master process.

* **ready**() - master process is ready.

### Client methods

* **(constructor)**() - Creates and returns a new Client instance.

* **connect**(< _object_ >config) - _(void)_ - Attempts a connection to a server using the information given in `config`:

    * **forceIPv4** - _boolean_ - Only connect via resolved IPv4 address for `host`. **Default:** `false`

    * **forceIPv6** - _boolean_ - Only connect via resolved IPv6 address for `host`. **Default:** `false`

    * **host** - _string_ - Hostname or IP address of the server. **Default:** `'localhost'`

    * **port** - _integer_ - Port number of the server. **Default:** `22`

    * **identityFile** - _string_ - Path to a private key file. **Default:** (none)

    * **username** - _string_ - Username for authentication. **Default:** (none)

    * **options** - _string[]_ - Array of ssh options, see **ssh_config(5)**. **Default:** (none)

    * **jumpHosts** - _string_ - Comma separated list of jump hosts. **Default:** (none)

* **end**() - _(void)_ - Disconnects the client.

* **exec**(< _string_ >command[, < _object_ >options], < _function_ >callback) - _(void)_ - Executes `command` on the server. `callback` has 2 parameters: < _Error_ >err, < _Channel_ >stream. `options` - process spawn options. 

* **forwardOut**(< _string_ >srcIP, < _integer_ >srcPort, < _string_ >dstIP, < _integer_ >dstPort, < _function_ >callback) - _(void)_ - Open a connection with `srcIP` and `srcPort` as the originating address and port and `dstIP` and `dstPort` as the remote destination address and port. `callback` has 2 parameters: < _Error_ >err, < _Channel_ >stream.

* **forwardOutLocalSocket**(< _string_ >localSocket, < _string_ >dstIP, < _integer_ >dstPort, < _function_ >callback) - _(void)_ - Connections to the given Unix socket `localSocket` on the local (client) host are to be forwarded to the given host `dstIP` and port `dstPort` on the remote side. `callback` has 2 parameters: < _Error_ >err, < _Channel_ >stream.

