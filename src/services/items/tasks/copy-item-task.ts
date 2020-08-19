// global
import { GraaspError } from 'util/graasp-error';
import { DatabaseTransactionHandler } from 'plugins/database';
import { TaskStatus } from 'interfaces/task';
import { MAX_DESCENDANTS_FOR_COPY, MAX_TREE_LEVELS } from 'util/config';
// other services
import { ItemMembershipService } from 'services/item-memberships/db-service';
import { PermissionLevel as pl } from 'services/item-memberships/interfaces/item-membership';
import { BaseItemMembership } from 'services/item-memberships/base-item-membership';
import { Member } from 'services/members/interfaces/member';
// local
import { ItemService } from '../db-service';
import { BaseItemTask } from './base-item-task';
import { BaseItem } from '../base-item';
import { Item } from '../interfaces/item';

class CopyItemSubTask extends BaseItemTask {
  private createMembership: boolean;
  get name() { return CopyItemSubTask.name; }

  constructor(member: Member, data: Partial<Item>,
    itemService: ItemService, itemMembershipService: ItemMembershipService,
    createMembership?: boolean) {
    super(member, itemService, itemMembershipService);
    this.data = data;
    this.createMembership = createMembership;
  }

  async run(handler: DatabaseTransactionHandler) {
    this._status = TaskStatus.Running;

    const item = await this.itemService.create(this.data, handler);

    if (this.createMembership) {
      const membership = new BaseItemMembership(this.actor.id, item.path, pl.Admin, this.actor.id);
      await this.itemMembershipService.create(membership, handler);
    }

    this._status = TaskStatus.OK;
    this._result = item;
  }
}

export class CopyItemTask extends BaseItemTask {
  get name() { return CopyItemTask.name; }

  constructor(member: Member, itemId: string,
    itemService: ItemService, itemMembershipService: ItemMembershipService,
    parentItemId?: string) {
    super(member, itemService, itemMembershipService);
    this.targetId = itemId;
    this.parentItemId = parentItemId;
  }

  async run(handler: DatabaseTransactionHandler) {
    this._status = TaskStatus.Running;

    // get item
    const item = await this.itemService.get(this.targetId, handler);
    if (!item) this.failWith(new GraaspError(GraaspError.ItemNotFound, this.targetId));

    // verify membership rights over item
    const itemPermissionLevel = await this.itemMembershipService.getPermissionLevel(this.actor, item, handler);
    if (!itemPermissionLevel) this.failWith(new GraaspError(GraaspError.UserCannotReadItem, this.targetId));

    // check how "big the tree is" below the item
    const numberOfDescendants = await this.itemService.getNumberOfDescendants(item, handler);
    if (numberOfDescendants > MAX_DESCENDANTS_FOR_COPY) {
      this.failWith(new GraaspError(GraaspError.TooManyDescendants, this.targetId));
    }

    let parentItem;
    let parentItemPermissionLevel;

    if (this.parentItemId) { // attaching copy to some item
      // get parent item
      parentItem = await this.itemService.get(this.parentItemId, handler);
      if (!parentItem) this.failWith(new GraaspError(GraaspError.ItemNotFound, this.parentItemId));

      // verify membership rights over parent item
      parentItemPermissionLevel = await this.itemMembershipService.getPermissionLevel(this.actor, parentItem, handler);
      if (parentItemPermissionLevel === pl.Read) {
        this.failWith(new GraaspError(GraaspError.UserCannotWriteItem, this.parentItemId));
      }

      // check how deep (number of levels) the resulting tree will be
      const levelsToFarthestChild =
        await this.itemService.getNumberOfLevelsToFarthestChild(item, handler);

      if (BaseItem.itemDepth(parentItem) + 1 + levelsToFarthestChild > MAX_TREE_LEVELS) {
        this.failWith(new GraaspError(GraaspError.HierarchyTooDeep));
      }
    }

    // copy (memberships from origin are not copied/kept)
    // get the whole tree
    const descendants = await this.itemService.getDescendants(item, handler, 'ASC');
    const treeItems = [item].concat(descendants as Item[]);
    const treeItemsCopy = this.copy(treeItems, parentItem);

    // return list of subtasks for task manager to copy item + all descendants, one by one.
    const createAdminMembership = !parentItem || parentItemPermissionLevel === pl.Write;

    return treeItemsCopy
      .map((item, index) => index === 0 ? // create 'admin' membership for 1st item if necessary
        new CopyItemSubTask(this.actor, item, this.itemService, this.itemMembershipService, createAdminMembership) :
        new CopyItemSubTask(this.actor, item, this.itemService, this.itemMembershipService)
      );
  }

  /**
   * Copy whole tree with new paths and same member as creator
   * @param tree Item and all descendants to copy
   * @param parentItem Parent item whose path will 'prefix' all paths
   */
  private copy(tree: Item[], parentItem?: Item) {
    const old2New = new Map<string, Item>();

    for (let i = 0; i < tree.length; i++) {
      const { name, description, path, extra } = tree[i];
      const pathSplit = path.split('.');
      const oldId_ = pathSplit.pop();
      let item;

      if (i === 0) {
        item = new BaseItem(name, description, extra, this.actor.id, parentItem);
      } else {
        const oldParentId_ = pathSplit.pop();
        item = new BaseItem(name, description, extra, this.actor.id, old2New.get(oldParentId_));
      }

      old2New.set(oldId_, item);
    }

    return Array.from(old2New.values());
  }
}