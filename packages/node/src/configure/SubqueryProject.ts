// // Copyright 2020-2025 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import fs from 'fs';
import os from 'os';
import { sep } from 'path';
import { isMainThread } from 'worker_threads';
import {
  CosmosProjectNetworkConfig,
  parseCosmosProjectManifest,
  isRuntimeCosmosDs as isRuntimeDs,
  isCustomCosmosDs as isCustomDs,
} from '@subql/common-cosmos';
import { CronFilter, WorkerHost, BaseSubqueryProject } from '@subql/node-core';
import { Reader } from '@subql/types-core';
import {
  CosmosDatasource,
  CustomDatasourceTemplate,
  RuntimeDatasourceTemplate,
  CosmosHandlerKind,
  CosmosBlockFilter,
} from '@subql/types-cosmos';
import { processNetworkConfig } from '../utils/project';

const { version: packageVersion } = require('../../package.json');

export type CosmosProjectDsTemplate =
  | RuntimeDatasourceTemplate
  | CustomDatasourceTemplate;

export type SubqlProjectBlockFilter = CosmosBlockFilter & CronFilter;

// This is the runtime type after we have mapped genesisHash to chainId and endpoint/dict have been provided when dealing with deployments
type NetworkConfig = CosmosProjectNetworkConfig & { chainId: string };

export type SubqueryProject = BaseSubqueryProject<
  CosmosDatasource,
  CosmosProjectDsTemplate,
  NetworkConfig
> & { tempDir?: string };

export async function createSubQueryProject(
  path: string,
  rawManifest: unknown,
  reader: Reader,
  root: string, // If project local then directory otherwise temp directory
  networkOverrides?: Partial<NetworkConfig>,
): Promise<SubqueryProject> {
  const project = await BaseSubqueryProject.create<SubqueryProject>({
    parseManifest: (raw) => parseCosmosProjectManifest(raw).asV1_0_0,
    path,
    rawManifest,
    reader,
    root,
    nodeSemver: packageVersion,
    blockHandlerKind: CosmosHandlerKind.Block,
    networkOverrides,
    isRuntimeDs,
    isCustomDs,
  });

  (project.network as any) = await processNetworkConfig(
    project.network,
    reader,
  );
  project.tempDir = getTempDir();

  return project;
}

/**
 * Gets a temp dir shared between main thread and workers
 * */
function getTempDir(): string {
  if (isMainThread) return fs.mkdtempSync(`${os.tmpdir()}${sep}`);
  const workerTempDir = (
    (global as any).host as WorkerHost<any> | undefined
  )?.getWorkerData()?.tempDir;

  if (!workerTempDir) {
    throw new Error(
      'Worker expected tempDir to be provided through workerData',
    );
  }
  return workerTempDir;
}
