// Copyright 2020-2024 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import { Inject, Injectable } from '@nestjs/common';
import {
  CosmosRuntimeDataSourceImpl,
  isCustomCosmosDs,
  isRuntimeCosmosDs,
} from '@subql/common-cosmos';
import {
  DatasourceParams,
  DynamicDsService as BaseDynamicDsService,
} from '@subql/node-core';
import { CosmosDatasource, CosmosHandlerKind } from '@subql/types-cosmos';
import { plainToClass, ClassConstructor } from 'class-transformer';
import { validateSync, IsOptional, IsObject } from 'class-validator';
import { SubqueryProject } from '../configure/SubqueryProject';
import { DsProcessorService } from './ds-processor.service';

class DataSourceArgs {
  @IsOptional()
  @IsObject()
  values?: Record<string, string>;

  @IsOptional()
  @IsObject()
  attributes?: Record<string, string>;
}

function validateType<T extends object>(
  classtype: ClassConstructor<T>,
  data: T,
  errorPrefix: string,
) {
  const parsed = plainToClass(classtype, data);

  const errors = validateSync(parsed, {
    whitelist: true,
    forbidNonWhitelisted: false,
  });
  if (errors.length) {
    throw new Error(
      `${errorPrefix}\n${errors.map((e) => e.toString()).join('\n')}`,
    );
  }
}

@Injectable()
export class DynamicDsService extends BaseDynamicDsService<
  CosmosDatasource,
  SubqueryProject
> {
  constructor(
    private readonly dsProcessorService: DsProcessorService,
    @Inject('ISubqueryProject') project: SubqueryProject,
  ) {
    super(project);
  }

  protected async getDatasource(
    params: DatasourceParams,
  ): Promise<CosmosDatasource> {
    const dsObj = this.getTemplate<CosmosDatasource>(
      params.templateName,
      params.startBlock,
    );

    try {
      if (isCustomCosmosDs(dsObj)) {
        dsObj.processor.options = {
          ...dsObj.processor.options,
          ...params.args,
        };
        await this.dsProcessorService.validateCustomDs([dsObj]);
      } else if (isRuntimeCosmosDs(dsObj)) {
        validateType(
          DataSourceArgs,
          params.args,
          'Dynamic ds args are invalid',
        );

        dsObj.mapping.handlers = dsObj.mapping.handlers.map((handler) => {
          switch (handler.kind) {
            case CosmosHandlerKind.Event:
              if (handler.filter) {
                return {
                  ...handler,
                  filter: {
                    ...handler.filter,
                    messageFilter: {
                      ...handler.filter.messageFilter,
                      values: {
                        ...handler.filter.messageFilter.values,
                        ...(params.args.values as Record<string, string>),
                      },
                    },
                    attributes: {
                      ...handler.filter.attributes,
                      ...(params.args.attributes as Record<string, string>),
                    },
                  },
                };
              }
              return handler;
            case CosmosHandlerKind.Message:
              if (handler.filter) {
                return {
                  ...handler,
                  filter: {
                    ...handler.filter,
                    values: {
                      ...handler.filter.values,
                      ...(params.args.values as Record<string, string>),
                    },
                  },
                };
              }
              return handler;
            case CosmosHandlerKind.Transaction:
            case CosmosHandlerKind.Block:
            default:
              return handler;
          }
        });

        validateType(
          CosmosRuntimeDataSourceImpl,
          dsObj,
          'Dynamic ds is invalid',
        );
      }

      return dsObj;
    } catch (e) {
      throw new Error(`Unable to create dynamic datasource.\n ${e.message}`);
    }
  }
}
