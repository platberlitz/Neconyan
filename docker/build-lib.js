import getWebpackServeMiddleware from '../src/middleware/webpack-serve.js';

const middleware = getWebpackServeMiddleware({ forceDist: true });
await middleware.runWebpackCompiler();
