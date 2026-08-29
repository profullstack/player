import { defineConfig } from 'tsup';

/**
 * Two entry points, ESM only, and the engines left as separate chunks.
 *
 * `splitting` is what makes the lazy loading real: `import('../engines/hls')`
 * becomes its own chunk, so a consumer's bundler can leave hls.js and mpegts.js
 * out of the initial payload. Inlining them would put half a megabyte of
 * demuxer on every page that shows a video, which is the thing this package is
 * supposed to stop.
 *
 * hls.js and mpegts.js stay external: they are dependencies, and bundling a
 * copy into this package would defeat deduplication and double the download for
 * anyone who already has one.
 */
export default defineConfig({
  entry: ['src/index.ts', 'src/react/index.tsx'],
  format: ['esm'],
  target: 'es2022',
  splitting: true,
  sourcemap: true,
  clean: true,
  dts: true,
  treeshake: true,
  external: ['react', 'hls.js', 'mpegts.js'],
  // The stylesheet is shipped as-is for the host to import; it is not compiled
  // into the JS, because a host that wants to restyle needs the cascade.
  publicDir: false,
  loader: { '.css': 'copy' },
  onSuccess: 'cp src/player.css dist/player.css',
});
