const { spawn } = require('child_process');
const http = require('http');

const PORT = 4000;
const env = { ...process.env, PORT: PORT.toString(), SHOPIFY_API_SECRET_KEY: 'test' };

const server = spawn('node', ['api/order-creation.js'], { env });
server.stdout.on('data', d => process.stdout.write(d.toString()));
server.stderr.on('data', d => process.stderr.write(d.toString()));

setTimeout(() => {
  const req = http.request({
    hostname: 'localhost',
    port: PORT,
    path: '/webhook/order-creation',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, res => {
    console.log('Response status:', res.statusCode);
    res.resume();
    res.on('end', () => server.kill());
  });
  req.write('{}');
  req.end();
}, 1000);
