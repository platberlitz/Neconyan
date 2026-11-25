import getWebpackServeMiddleware from '../src/middleware/webpack-serve.js';

// The server serves each of these bundles. The image's dist folder belongs to the build user,
// so a container running as another user cannot compile one at run time and must reuse it.
for (const bundle of ['lib', 'notes-editor']) {
    await getWebpackServeMiddleware({ forceDist: true, bundle }).runWebpackCompiler();
}
