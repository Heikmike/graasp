import { ItemType } from '@graasp/sdk';

import { AppDataSource } from '../../../../../plugins/datasource';
import { ItemNotFound } from '../../../../../utils/errors';
import { MemberIdentifierNotFound } from '../../../../itemLogin/errors';
import { appSettingSchema } from '../../../../member/plugins/export-data/schemas/schemas';
import { schemaToSelectMapper } from '../../../../member/plugins/export-data/utils/selection.utils';
import { AppSetting } from './appSettings';
import { AppSettingNotFound, PreventUpdateAppSettingFile } from './errors';
import { InputAppSetting } from './interfaces/app-setting';

export const AppSettingRepository = AppDataSource.getRepository(AppSetting).extend({
  async post(
    itemId: string,
    memberId: string | undefined,
    body: Partial<InputAppSetting>,
  ): Promise<AppSetting> {
    const appSetting = await this.insert({
      ...body,
      item: { id: itemId },
      creator: { id: memberId },
    });

    // TODO: better solution?
    // query builder returns creator as id and extra as string
    return this.get(appSetting.identifiers[0].id);
  },

  async patch(
    itemId: string,
    appSettingId: string,
    body: Partial<AppSetting>,
  ): Promise<AppSetting> {
    // shouldn't update file data
    // TODO: optimize and refactor
    const originalData = await this.get(appSettingId);
    if ([ItemType.LOCAL_FILE, ItemType.S3_FILE].includes(originalData?.data?.type)) {
      throw new PreventUpdateAppSettingFile(originalData);
    }

    await this.update({ id: appSettingId, item: { id: itemId } }, body);

    // TODO: optimize
    return this.get(appSettingId);
  },

  async deleteOne(itemId: string, appSettingId: string): Promise<string> {
    const deleteResult = await this.delete(appSettingId);

    if (!deleteResult.affected) {
      throw new AppSettingNotFound(appSettingId);
    }

    return appSettingId;
  },

  async get(id: string): Promise<AppSetting> {
    // additional check that id is not null
    // o/w empty parameter to findOneBy return the first entry
    if (!id) {
      throw new AppSettingNotFound(id);
    }
    return this.findOne({ where: { id }, relations: { creator: true, item: true } });
  },

  /**
   * Return all the app settings generated by the given member.
   * @param memberId ID of the member to retrieve the data.
   * @returns an array of app settings generated by the member.
   */
  async getForMemberExport(memberId: string): Promise<AppSetting[]> {
    if (!memberId) {
      throw new MemberIdentifierNotFound();
    }

    return this.find({
      select: schemaToSelectMapper(appSettingSchema),
      where: { creator: { id: memberId } },
      order: { updatedAt: 'DESC' },
      relations: {
        item: true,
      },
    });
  },

  getForItem(itemId: string, name?: string): Promise<AppSetting[]> {
    if (!itemId) {
      throw new ItemNotFound(itemId);
    }
    return this.find({
      where: {
        item: { id: itemId },
        ...(name ? { name } : undefined),
      },
      relations: { creator: true, item: true },
    });
  },
});
