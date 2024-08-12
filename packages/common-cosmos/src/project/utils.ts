// Copyright 2020-2024 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import {FileReference, BaseTemplateDataSource} from '@subql/types-core';
import {
  SecondLayerHandlerProcessor,
  CosmosCustomDatasource,
  CosmosDatasource,
  CosmosDatasourceKind,
  CosmosHandlerKind,
  CosmosRuntimeDatasource,
  CustomDatasourceTemplate,
  RuntimeDatasourceTemplate,
  SecondLayerHandlerProcessorArray,
} from '@subql/types-cosmos';
import {ValidationArguments, ValidatorConstraint, ValidatorConstraintInterface} from 'class-validator';
import {gte} from 'semver';

export function isCustomCosmosDs(
  ds: CosmosDatasource | BaseTemplateDataSource<CosmosDatasource>
): ds is CosmosCustomDatasource<string> {
  return ds.kind !== CosmosDatasourceKind.Runtime && !!(ds as CosmosCustomDatasource<string>).processor;
}

export function isRuntimeCosmosDs(
  ds: CosmosDatasource | BaseTemplateDataSource<CosmosDatasource>
): ds is CosmosRuntimeDatasource {
  return ds.kind === CosmosDatasourceKind.Runtime;
}

type DefaultFilter = Record<string, unknown>;

export function isBlockHandlerProcessor<E>(
  hp: SecondLayerHandlerProcessorArray<CosmosHandlerKind, DefaultFilter, unknown>
): hp is SecondLayerHandlerProcessor<CosmosHandlerKind.Block, DefaultFilter, E> {
  return hp.baseHandlerKind === CosmosHandlerKind.Block;
}

export function isTransactionHandlerProcessor<E>(
  hp: SecondLayerHandlerProcessorArray<CosmosHandlerKind, DefaultFilter, unknown>
): hp is SecondLayerHandlerProcessor<CosmosHandlerKind.Transaction, DefaultFilter, E> {
  return hp.baseHandlerKind === CosmosHandlerKind.Transaction;
}

export function isMessageHandlerProcessor<E>(
  hp: SecondLayerHandlerProcessorArray<CosmosHandlerKind, DefaultFilter, unknown>
): hp is SecondLayerHandlerProcessor<CosmosHandlerKind.Message, DefaultFilter, E> {
  return hp.baseHandlerKind === CosmosHandlerKind.Message;
}

export function isEventHandlerProcessor<E>(
  hp: SecondLayerHandlerProcessorArray<CosmosHandlerKind, DefaultFilter, unknown>
): hp is SecondLayerHandlerProcessor<CosmosHandlerKind.Event, DefaultFilter, E> {
  return hp.baseHandlerKind === CosmosHandlerKind.Event;
}

export function isCosmosTemplates(
  templatesData: any,
  specVersion: string
): templatesData is (RuntimeDatasourceTemplate | CustomDatasourceTemplate)[] {
  return (isRuntimeCosmosDs(templatesData[0]) || isCustomCosmosDs(templatesData[0])) && gte(specVersion, '0.2.1');
}

@ValidatorConstraint({name: 'isFileReference', async: false})
export class FileReferenceImp implements ValidatorConstraintInterface {
  validate(value: Map<string, FileReference>): boolean {
    if (!value) {
      return false;
    }
    return !!Object.values(value).find((fileReference: FileReference) => this.isValidFileReference(fileReference));
  }
  defaultMessage(args: ValidationArguments): string {
    return `${JSON.stringify(args.value)} is not a valid assets format`;
  }

  private isValidFileReference(fileReference: FileReference): boolean {
    return typeof fileReference === 'object' && 'file' in fileReference && typeof fileReference.file === 'string';
  }
}
