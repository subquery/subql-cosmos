// Copyright 2020-2024 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import { sep } from 'path';
import { isMainThread } from 'worker_threads';
import { Injectable } from '@nestjs/common';
import { validateSemver } from '@subql/common';
import {
  CosmosProjectNetworkConfig,
  parseCosmosProjectManifest,
  ProjectManifestV1_0_0Impl,
  isRuntimeCosmosDs,
  isCustomCosmosDs,
} from '@subql/common-cosmos';
import {
  CronFilter,
  insertBlockFiltersCronSchedules,
  ISubqueryProject,
  loadProjectTemplates,
  updateDataSourcesV1_0_0,
  WorkerHost,
} from '@subql/node-core';
import { ParentProject, Reader, RunnerSpecs } from '@subql/types-core';
import {
  CosmosDatasource,
  CustomDatasourceTemplate,
  RuntimeDatasourceTemplate,
  CosmosHandlerKind,
  CosmosBlockFilter,
} from '@subql/types-cosmos';
import { buildSchemaFromString } from '@subql/utils';
import { GraphQLSchema } from 'graphql';
import { processNetworkConfig } from '../utils/project';

const { version: packageVersion } = require('../../package.json');

export type CosmosProjectDsTemplate =
  | RuntimeDatasourceTemplate
  | CustomDatasourceTemplate;

export type SubqlProjectBlockFilter = CosmosBlockFilter & CronFilter;

const NOT_SUPPORT = (name: string) => {
  throw new Error(`Manifest specVersion ${name} is not supported`);
};

// This is the runtime type after we have mapped genesisHash to chainId and endpoint/dict have been provided when dealing with deployments
type NetworkConfig = CosmosProjectNetworkConfig & { chainId: string };

@Injectable()
export class SubqueryProject implements ISubqueryProject {
  #dataSources: CosmosDatasource[];

  constructor(
    readonly id: string,
    readonly root: string,
    readonly network: NetworkConfig,
    dataSources: CosmosDatasource[],
    readonly schema: GraphQLSchema,
    readonly templates: CosmosProjectDsTemplate[],
    readonly runner?: RunnerSpecs,
    readonly parent?: ParentProject,
    readonly tempDir?: string,
  ) {
    this.#dataSources = dataSources;
  }

  get dataSources(): CosmosDatasource[] {
    return this.#dataSources;
  }

  async applyCronTimestamps(
    getTimestamp: (height: number) => Promise<Date>,
  ): Promise<void> {
    this.#dataSources = await insertBlockFiltersCronSchedules(
      this.dataSources,
      getTimestamp,
      isRuntimeCosmosDs,
      CosmosHandlerKind.Block,
    );
  }

  static async create(
    path: string,
    rawManifest: unknown,
    reader: Reader,
    root: string,
    networkOverrides?: Partial<CosmosProjectNetworkConfig>,
  ): Promise<SubqueryProject> {
    // rawManifest and reader can be reused here.
    // It has been pre-fetched and used for rebase manifest runner options with args
    // in order to generate correct configs.

    // But we still need reader here, because path can be remote or local
    // and the `loadProjectManifest(projectPath)` only support local mode
    if (rawManifest === undefined) {
      throw new Error(`Get manifest from project path ${path} failed`);
    }

    const manifest = parseCosmosProjectManifest(rawManifest);

    if (!manifest.isV1_0_0) {
      NOT_SUPPORT('<1.0.0');
    }

    return loadProjectFromManifestBase(
      manifest.asV1_0_0,
      reader,
      path,
      root,
      networkOverrides,
    );
  }
}

type SUPPORT_MANIFEST = ProjectManifestV1_0_0Impl;

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

async function loadProjectFromManifestBase(
  projectManifest: SUPPORT_MANIFEST,
  reader: Reader,
  path: string,
  root: string,
  networkOverrides?: Partial<CosmosProjectNetworkConfig>,
): Promise<SubqueryProject> {
  if (typeof projectManifest.network.endpoint === 'string') {
    projectManifest.network.endpoint = [projectManifest.network.endpoint];
  }

  const network = await processNetworkConfig(
    {
      ...projectManifest.network,
      ...networkOverrides,
    },
    reader,
  );

  if (!network.endpoint) {
    throw new Error(
      `Network endpoint must be provided for network. chainId="${network.chainId}"`,
    );
  }

  let schemaString: string;
  try {
    schemaString = await reader.getFile(projectManifest.schema.file);
  } catch (e) {
    throw new Error(
      `unable to fetch the schema from ${projectManifest.schema.file}`,
    );
  }
  const schema = buildSchemaFromString(schemaString);

  const dataSources = await updateDataSourcesV1_0_0(
    projectManifest.dataSources,
    reader,
    root,
    isCustomCosmosDs,
  );

  const templates = await loadProjectTemplates(
    projectManifest.templates,
    root,
    reader,
    isCustomCosmosDs,
  );
  const runner = projectManifest.runner;
  assert(
    validateSemver(packageVersion, runner.node.version),
    new Error(
      `Runner require node version ${runner.node.version}, current node ${packageVersion}`,
    ),
  );

  return new SubqueryProject(
    reader.root ? reader.root : path, //TODO, need to method to get project_id
    root,
    network,
    dataSources,
    schema,
    templates,
    runner,
    projectManifest.parent,
    getTempDir(),
  );
}
