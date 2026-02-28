// SECURITY SCAN TEST — DELETE THIS DIRECTORY AFTER VERIFYING SCANNERS
// This file should be flagged by CodeQL (js/code-injection)

const http = require("http");
const url = require("url");

http.createServer((req, res) => {
  const query = url.parse(req.url, true).query;
  const result = eval(query.code);
  res.end(String(result));
}).listen(8080);
