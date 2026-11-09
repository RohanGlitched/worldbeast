import base44 from '@base44/vite-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The hunt (the game, three.js) is a lazy chunk so the Hall and How it works never download it. On the hunt's
// own address, a tiny inline script preloads the hunt's chunks in parallel with the entry, so the cover does
// not pay an extra round trip for the split.
function preloadHunt() {
  let base = '/';
  return {
    name: 'worldbeast-preload-hunt',
    apply: 'build',
    configResolved(c) {
      base = c.base || '/';
    },
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        const bundle = ctx.bundle;
        if (!bundle) return html;
        const chunks = Object.values(bundle).filter((c) => c.type === 'chunk');
        const hunt = chunks.find((c) => c.facadeModuleId && /[\\/]src[\\/]ui[\\/]Hunt\.jsx$/.test(c.facadeModuleId));
        if (!hunt) return html;
        const files = [];
        const walk = (name) => {
          const c = bundle[name];
          if (!c || c.type !== 'chunk' || c.isEntry || files.includes(name)) return;
          files.push(name);
          c.imports.forEach(walk);
        };
        walk(hunt.fileName);
        const urls = JSON.stringify(files.map((f) => base + f));
        const css = JSON.stringify([...(hunt.viteMetadata?.importedCss ?? [])].map((f) => base + f));
        const js = `(function(){var p=location.pathname;if(p!=="/"&&p!=="")return;var h=document.head;${urls}.forEach(function(u){var l=document.createElement("link");l.rel="modulepreload";l.crossOrigin="";l.href=u;h.appendChild(l)});${css}.forEach(function(u){var l=document.createElement("link");l.rel="preload";l.as="style";l.href=u;h.appendChild(l)})})();`;
        // first in <head>: an inline script after a stylesheet would wait for it before running
        return { html, tags: [{ tag: 'script', children: js, injectTo: 'head-prepend' }] };
      },
    },
  };
}

export default defineConfig({
  plugins: [base44(), react(), preloadHunt()],
});
