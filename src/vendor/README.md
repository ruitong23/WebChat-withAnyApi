# Rendering dependencies

Browser assets are checked in so both source deployments and optional builds work without a CDN or a dependency installation. Package tarballs were fetched from the official npm registry and verified against these integrity values:

- markdown-it 15.0.3: https://www.npmjs.com/package/markdown-it/v/15.0.3
  Integrity: `sha512-+Az7Ojz3iRGu8KYMvJ6xVhvrxP3eE+vEtJX75Ow88XBpcQNV/0lGX5ZynIIBftREo4DC2jsveAMDaeltmm8QvQ==`
- katex 0.19.1: https://www.npmjs.com/package/katex/v/0.19.1
  Integrity: `sha512-jG8uKntjSEcm2EpQOh0XturpPuuC9r3Sq5HLHdsFdWZT27E672SF19QEi+of0/YeOy15lDgRhKvr5614uRrEfA==`
- markdown-it-texmath 1.0.0: https://www.npmjs.com/package/markdown-it-texmath/v/1.0.0
  Integrity: `sha512-4hhkiX8/gus+6e53PLCUmUrsa6ZWGgJW2XCW6O0ASvZUiezIK900ZicinTDtG3kAO2kon7oUA/ReWmpW2FByxg==`

Local adaptations: `texmath.mjs` adds an ES module default export and trims upstream trailing whitespace. KaTeX CSS retains only WOFF2 font sources; all referenced WOFF2 files are included. Markdown-it uses its self-contained browser ES module. License texts are included alongside the distributions.

`manifest.json` is the exact static asset allowlist, not a directory listing endpoint. Update it whenever replacing these assets. The application disables raw HTML and untrusted KaTeX commands; math options and the bounded render cache live in `src/rendering.js`.
