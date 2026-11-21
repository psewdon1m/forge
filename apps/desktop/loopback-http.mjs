import { request } from 'node:http';

export const loopbackHost = '127.0.0.1';

export function postLoopback(port, route, body, contentType, signal, limit) {
  return new Promise((resolve, reject) => {
    const length = body.reduce((size, part) => size + part.length, 0);
    const connection = request({ hostname: loopbackHost, port, path: route, method: 'POST', signal, agent: false,
      headers: { 'content-type': contentType, 'content-length': length } }, response => {
      if (response.statusCode !== 200) {
        response.destroy();
        reject(new Error('Provider did not return a successful response'));
        return;
      }
      let size = 0;
      const buffers = [];
      response.on('data', part => {
        size += part.length;
        if (size > limit) response.destroy(new Error('Provider response is too large'));
        else buffers.push(part);
      });
      response.once('error', reject);
      response.once('aborted', () => reject(new Error('Provider response was interrupted')));
      response.once('end', () => resolve(Buffer.concat(buffers)));
    });
    connection.once('error', reject);
    for (const part of body) connection.write(part);
    connection.end();
  });
}
