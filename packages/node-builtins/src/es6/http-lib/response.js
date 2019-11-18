import { inherits } from 'util';
import { Readable } from 'stream';

import { overrideMimeType } from './capability';

const rStates = {
  UNSENT: 0,
  OPENED: 1,
  HEADERS_RECEIVED: 2,
  LOADING: 3,
  DONE: 4
};
export { rStates as readyStates };
export function IncomingMessage(xhr, response, mode) {
  const self = this;
  Readable.call(self);

  self._mode = mode;
  self.headers = {};
  self.rawHeaders = [];
  self.trailers = {};
  self.rawTrailers = [];

  // Fake the 'close' event, but only once 'end' fires
  self.on('end', () => {
    // The nextTick is necessary to prevent the 'request' module from causing an infinite loop
    process.nextTick(() => {
      self.emit('close');
    });
  });
  let read;
  if (mode === 'fetch') {
    self._fetchResponse = response;

    self.url = response.url;
    self.statusCode = response.status;
    self.statusMessage = response.statusText;
    // backwards compatible version of for (<item> of <iterable>):
    // for (var <item>,_i,_it = <iterable>[Symbol.iterator](); <item> = (_i = _it.next()).value,!_i.done;)
    for (
      var header, _i, _it = response.headers[Symbol.iterator]();
      (header = (_i = _it.next()).value), !_i.done;

    ) {
      self.headers[header[0].toLowerCase()] = header[1];
      self.rawHeaders.push(header[0], header[1]);
    }

    // TODO: this doesn't respect backpressure. Once WritableStream is available, this can be fixed
    const reader = response.body.getReader();

    read = function() {
      reader.read().then((result) => {
        if (self._destroyed) return;
        if (result.done) {
          self.push(null);
          return;
        }
        self.push(new Buffer(result.value));
        read();
      });
    };
    read();
  } else {
    self._xhr = xhr;
    self._pos = 0;

    self.url = xhr.responseURL;
    self.statusCode = xhr.status;
    self.statusMessage = xhr.statusText;
    const headers = xhr.getAllResponseHeaders().split(/\r?\n/);
    headers.forEach((header) => {
      const matches = header.match(/^([^:]+):\s*(.*)/);
      if (matches) {
        const key = matches[1].toLowerCase();
        if (key === 'set-cookie') {
          if (self.headers[key] === undefined) {
            self.headers[key] = [];
          }
          self.headers[key].push(matches[2]);
        } else if (self.headers[key] !== undefined) {
          self.headers[key] += `, ${matches[2]}`;
        } else {
          self.headers[key] = matches[2];
        }
        self.rawHeaders.push(matches[1], matches[2]);
      }
    });

    self._charset = 'x-user-defined';
    if (!overrideMimeType) {
      const mimeType = self.rawHeaders['mime-type'];
      if (mimeType) {
        const charsetMatch = mimeType.match(/;\s*charset=([^;])(;|$)/);
        if (charsetMatch) {
          self._charset = charsetMatch[1].toLowerCase();
        }
      }
      if (!self._charset) self._charset = 'utf-8'; // best guess
    }
  }
}

inherits(IncomingMessage, Readable);

IncomingMessage.prototype._read = function() {};

IncomingMessage.prototype._onXHRProgress = function() {
  const self = this;

  const xhr = self._xhr;

  let response = null;
  switch (self._mode) {
    case 'text:vbarray': // For IE9
      if (xhr.readyState !== rStates.DONE) break;
      try {
        // This fails in IE8
        response = new global.VBArray(xhr.responseBody).toArray();
      } catch (e) {
        // pass
      }
      if (response !== null) {
        self.push(new Buffer(response));
        break;
      }
    // Falls through in IE8
    case 'text':
      try {
        // This will fail when readyState = 3 in IE9. Switch mode and wait for readyState = 4
        response = xhr.responseText;
      } catch (e) {
        self._mode = 'text:vbarray';
        break;
      }
      if (response.length > self._pos) {
        const newData = response.substr(self._pos);
        if (self._charset === 'x-user-defined') {
          const buffer = new Buffer(newData.length);
          for (let i = 0; i < newData.length; i++) buffer[i] = newData.charCodeAt(i) & 0xff;

          self.push(buffer);
        } else {
          self.push(newData, self._charset);
        }
        self._pos = response.length;
      }
      break;
    case 'arraybuffer':
      if (xhr.readyState !== rStates.DONE || !xhr.response) break;
      response = xhr.response;
      self.push(new Buffer(new Uint8Array(response)));
      break;
    case 'moz-chunked-arraybuffer': // take whole
      response = xhr.response;
      if (xhr.readyState !== rStates.LOADING || !response) break;
      self.push(new Buffer(new Uint8Array(response)));
      break;
    case 'ms-stream':
      response = xhr.response;
      if (xhr.readyState !== rStates.LOADING) break;
      var reader = new global.MSStreamReader();
      reader.onprogress = function() {
        if (reader.result.byteLength > self._pos) {
          self.push(new Buffer(new Uint8Array(reader.result.slice(self._pos))));
          self._pos = reader.result.byteLength;
        }
      };
      reader.onload = function() {
        self.push(null);
      };
      // reader.onerror = ??? // TODO: this
      reader.readAsArrayBuffer(response);
      break;
  }

  // The ms-stream case handles end separately in reader.onload()
  if (self._xhr.readyState === rStates.DONE && self._mode !== 'ms-stream') {
    self.push(null);
  }
};