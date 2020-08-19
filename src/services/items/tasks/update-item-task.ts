// global
import { GraaspError } from 'util/graasp-error';
import { DatabaseTransactionHandler } from 'plugins/database';
import { TaskStatus } from 'interfaces/task';
import { MAX_DESCENDANTS_FOR_UPDATE } from 'util/config';
// other services
import { ItemMembershipService } from 'services/item-memberships/db-service';
import { Member } from 'services/members/interfaces/member';
// local
import { ItemService } from '../db-service';
import { BaseItemTask } from './base-item-task';
import { Item } from '../interfaces/item';
import { BaseItem } from '../base-item';

class UpdateItemSubTask extends BaseItemTask {
  get name() { return UpdateItemSubTask.name; }

  constructor(member: Member, itemId: string, data: Partial<Item>,
    itemService: ItemService, itemMembershipService: ItemMembershipService) {
    super(member, itemService, itemMembershipService);
    this.data = data;
    this.targetId = itemId;
  }

  async run(handler: DatabaseTransactionHandler) {
    this._status = TaskStatus.Running;
    const item = await this.itemService.update(this.targetId, this.data, handler);
    this._status = TaskStatus.OK;
    this._result = item;
  }
}

export class UpdateItemTask extends BaseItemTask {
  get name() { return UpdateItemTask.name; }

  constructor(member: Member, itemId: string, data: Partial<Item>,
    itemService: ItemService, itemMembershipService: ItemMembershipService) {
    super(member, itemService, itemMembershipService);
    this.data = data;
    this.targetId = itemId;
  }

  private extractPropagatingChanges() {
    return BaseItem.propagatingProperties.reduce(
      (acc, key) => this.data[key] != null ? { ...acc, [key]: this.data[key] } : acc,
      {}
    );
  }

  async run(handler: DatabaseTransactionHandler) {
    this._status = TaskStatus.Running;

    // get item
    const item = await this.itemService.get(this.targetId, handler);
    if (!item) this.failWith(new GraaspError(GraaspError.ItemNotFound, this.targetId));

    // verify membership rights over item - write
    const hasRights = await this.itemMembershipService.canWrite(this.actor, item, handler);
    if (!hasRights) this.failWith(new GraaspError(GraaspError.UserCannotWriteItem, this.targetId));

    // prepare changes
    // allow for individual changes in extra's own properties except if 'extra' is {};
    // in that case 'extra' is fully replace by {} (empty object).
    if (this.data.extra && Object.keys(this.data.extra).length > 0) {
      this.data.extra = Object.assign({}, item.extra, this.data.extra);
    }

    // check if there's any propagating changes
    const propagatingChanges: Partial<Item> = this.extractPropagatingChanges();
    if (Object.keys(propagatingChanges).length) {
      // get descendants
      const descendants = await this.itemService.getDescendants(item, handler, 'DESC', ['id']);

      // check how "big the tree is" below the item
      if (descendants.length > MAX_DESCENDANTS_FOR_UPDATE) {
        this.failWith(new GraaspError(GraaspError.TooManyDescendants, this.targetId));
      } else if (descendants.length > 0) {
        // return list of subtasks for task manager to execute and
        // update item + all descendants, one by one.
        return descendants
          // for all the descendants only pass the propagating changes
          .map(i => new UpdateItemSubTask(this.actor, i.id, propagatingChanges, this.itemService, this.itemMembershipService))
          // for the target item, pass all the changes
          .concat(new UpdateItemSubTask(this.actor, this.targetId, this.data, this.itemService, this.itemMembershipService));
      }
    }

    // no propagating changes: just update target item
    this._result = await this.itemService.update(this.targetId, this.data, handler);
    this._status = TaskStatus.OK;
  }
}