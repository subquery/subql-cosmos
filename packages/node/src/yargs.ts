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
    kyveChainId: {
      demandOption: false,
      describe:
        'When indexing from Kyve, please implement a supported kyve chain-id, it is defaulted to "kyve-1"',
      type: 'string',
    },
    kyveEndpoint: {
      demandOption: false,
      describe:
        'If indexing a network that Kyve supports adding a Kyve RPC endpoint will fetch blocks from Kyve',
      type: 'string',
    },
    storageUrl: {
      demandOption: false,
      describe:
        'When indexing from kyve, you can alternatively provide a different storageUrl to index data from, it is defaulted to arweave.',
      type: 'string',
    },
  },
});
