import data from './fixtures/kinds.json';
import type { KindDef } from '../src/types';

export const KINDS = data as unknown as KindDef[];
export const kind = (id: string): KindDef => KINDS.find((k) => k.id === id)!;
