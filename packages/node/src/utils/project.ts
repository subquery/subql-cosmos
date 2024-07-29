// Copyright 2020-2024 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import os from 'os';
import {
  CosmosRuntimeHandler,
  CosmosCustomHandler,
  CosmosHandler,
  CosmosHandlerKind,
  CosmosProjectNetConfig,
  CosmosChainType,
} from '@subql/common-cosmos';
import { Reader } from '@subql/types-core';
import * as protobuf from 'protobufjs';

export function isBaseHandler(
  handler: CosmosHandler,
): handler is CosmosRuntimeHandler {
  return Object.values<string>(CosmosHandlerKind).includes(handler.kind);
}

export function isCustomHandler(
  handler: CosmosHandler,
): handler is CosmosCustomHandler {
  return !isBaseHandler(handler);
}

export async function processNetworkConfig(
  network: any,
  reader: Reader,
): Promise<CosmosProjectNetConfig> {
  const chaintypes = new Map<string, CosmosChainType>() as Map<
    string,
    CosmosChainType
  > & { protoRoot: protobuf.Root };
  if (!network.chaintypes) {
    network.chaintypes = chaintypes;
    return network;
  }

  const protoRoot = new protobuf.Root();
  for (const [key, value] of network.chaintypes) {
    const [packageName, proto] = await loadNetworkChainType(reader, value.file);
    chaintypes.set(key, { ...value, packageName, proto });

    protoRoot.add(proto);
  }
  chaintypes.protoRoot = protoRoot;
  network.chaintypes = chaintypes;
  return network;
}

export async function loadNetworkChainType(
  reader: Reader,
  file: string,
): Promise<[string, protobuf.Root]> {
  const proto = await reader.getFile(file);

  if (!proto) throw new Error(`Unable to load chain type from ${file}`);

  const { package: packageName, root } = protobuf.parse(proto);

  return [packageName, root];
}

export function isTmpDir(path: string): boolean {
  const normalizedPath = path.replace(/\\/g, '/').toLowerCase();
  return normalizedPath.startsWith(
    os.tmpdir().replace(/\\/g, '/').toLowerCase(),
  );
}
