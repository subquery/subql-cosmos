// Copyright 2020-2023 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import {TelescopeOptions} from '@cosmology/types/types/telescope';

export const TELESCOPE_OPTS: TelescopeOptions = {
  removeUnusedImports: true,
  tsDisable: {
    patterns: ['**/*amino.ts', '**/*registry.ts'],
  },
  // experimentalGlobalProtoNamespace: true, //  [ 'v1beta1' ] concentratedliquidity
  interfaces: {
    enabled: true,
    useUnionTypes: false,
  },
  prototypes: {
    enabled: false,
    addTypeUrlToDecoders: true,
    addTypeUrlToObjects: true,
    excluded: {
      packages: [
        'amino',
        'gogoproto',
        // 'google.api',
        // 'ibc.core.port.v1',
        // 'ibc.core.types.v1',
      ],
    },
    methods: {
      fromJSON: false,
      toJSON: false,

      encode: false,
      decode: false,
      fromPartial: false,

      toSDK: false,
      fromSDK: false,

      toAmino: false,
      fromAmino: false,
      fromProto: false,
      toProto: false,
    },
    parser: {
      keepCase: false,
    },
    typingsFormat: {
      duration: 'duration',
      timestamp: 'date',
      useExact: false,
      useDeepPartial: false,
    },
  },
  aminoEncoding: {
    enabled: false,
    exceptions: {},
    useRecursiveV2encoding: true,
  },
  lcdClients: {
    enabled: false,
  },
  rpcClients: {
    // unsure if needed
    enabled: false,
    camelCase: true,
  },
};