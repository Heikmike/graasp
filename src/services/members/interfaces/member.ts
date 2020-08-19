// global
import { Actor } from 'interfaces/actor';

export enum MemberType {
  Individual = 'individual',
  Group = 'group'
}

export interface Member extends Actor {
  name: string;
  email: string;
  type: MemberType;
  createdAt: string;
  updatedAt: string;
}