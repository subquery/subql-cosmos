// // Copyright 2020-2025 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import { Inject, Injectable, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import {
  NestLogger,
  NodeConfig,
  TestingService as BaseTestingService,
  TestRunner,
  ProjectService,
  DbModule,
} from '@subql/node-core';
import { CosmosDatasource } from '@subql/types-cosmos';
import { ConfigureModule } from '../configure/configure.module';
import { SubqueryProject } from '../configure/SubqueryProject';
import { CosmosClient, CosmosSafeClient } from '../indexer/api.service';
import { BlockContent } from '../indexer/types';
import { TestingFeatureModule } from './testing.module';

@Module({
  imports: [
    DbModule.forRoot(),
    ConfigureModule.register(),
    EventEmitterModule.forRoot(),
    ScheduleModule.forRoot(),
    TestingFeatureModule,
  ],
  controllers: [],
})
export class TestingModule {}

@Injectable()
export class TestingService extends BaseTestingService<
  CosmosClient,
  CosmosSafeClient,
  BlockContent,
  CosmosDatasource
> {
  constructor(
    nodeConfig: NodeConfig,
    @Inject('ISubqueryProject') project: SubqueryProject,
  ) {
    super(nodeConfig, project);
  }

  async getTestRunner(): Promise<
    [
      close: () => Promise<void>,
      runner: TestRunner<
        CosmosClient,
        CosmosSafeClient,
        BlockContent,
        CosmosDatasource
      >,
    ]
  > {
    const testContext = await NestFactory.createApplicationContext(
      TestingModule,
      {
        logger: new NestLogger(),
      },
    );

    await testContext.init();

    const projectService: ProjectService = testContext.get('IProjectService');
    await projectService.init();

    return [testContext.close.bind(testContext), testContext.get(TestRunner)];
  }
}
