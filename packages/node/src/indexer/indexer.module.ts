// Copyright 2020-2022 OnFinality Limited authors & contributors
// SPDX-License-Identifier: Apache-2.0

import { Module } from '@nestjs/common';
import {
  StoreService,
  PoiService,
  MmrService,
  ConnectionPoolService,
} from '@subql/node-core';
import { SubqueryProject } from '../configure/SubqueryProject';
import { ApiService } from './api.service';
import { CosmosClientConnection } from './cosmosClient.connection';
import { DsProcessorService } from './ds-processor.service';
import { DynamicDsService } from './dynamic-ds.service';
import { IndexerManager } from './indexer.manager';
import { ProjectService } from './project.service';
import { SandboxService } from './sandbox.service';
import { WorkerService } from './worker/worker.service';

@Module({
  providers: [
    IndexerManager,
    StoreService,
    ConnectionPoolService,
    {
      provide: ApiService,
      useFactory: async (
        project: SubqueryProject,
        connectionPoolService: ConnectionPoolService<CosmosClientConnection>,
      ) => {
        const apiService = new ApiService(project, connectionPoolService);
        await apiService.init();
        return apiService;
      },
      inject: ['ISubqueryProject', ConnectionPoolService],
    },
    SandboxService,
    DsProcessorService,
    DynamicDsService,
    PoiService,
    MmrService,
    ProjectService,
    WorkerService,
  ],
  exports: [StoreService, MmrService],
})
export class IndexerModule {}
