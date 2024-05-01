// Copyright 2020-2024 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import { yargsBuilder } from '@subql/node-core/yargs';

export const yargsOptions = yargsBuilder({
  initTesting: () => {
    // lazy import to make sure logger is instantiated before all other services
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { testingInit } = require('./subcommands/testing.init');
    return testingInit();
  },
  initForceClean: () => {
    // lazy import to make sure logger is instantiated before all other services
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { forceCleanInit } = require('./subcommands/forceClean.init');
    return forceCleanInit();
  },
  initReindex: (targetHeight: number) => {
    // lazy import to make sure logger is instantiated before all other services
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { reindexInit } = require('./subcommands/reindex.init');
    return reindexInit(targetHeight);
  },
  runOptions: {
    'kyve-chain-id': {
      demandOption: false,
      describe: 'When indexing from Kyve, supported kyve chain-id',
      type: 'string',
      default: 'kyve-1',
    },
    'kyve-endpoint': {
      demandOption: false,
      describe:
        'If indexing a network that Kyve supports adding a Kyve LCD endpoint will fetch blocks from Kyve. Use `false` to disable kyve.',
      type: 'string',
      default: 'https://api-us-1.kyve.network',
    },
    'kyve-storage-url': {
      demandOption: false,
      describe:
        'When indexing from kyve, you can alternatively provide a different storageUrl to index data from, it is defaulted to arweave.',
      type: 'string',
      default: 'https://arweave.net',
    },
  },
});
