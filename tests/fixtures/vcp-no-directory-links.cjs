/* global require */
/* eslint-disable @typescript-eslint/no-require-imports -- Node CommonJS preload fixture. */
'use strict';

// Model a library filesystem on which dependency junctions are unavailable.
require('node:fs/promises').symlink = async () => {
  throw Object.assign(new Error('Directory links are unavailable in this library.'), { code: 'EPERM' });
};
