export interface SessionpageMessageHost {
  /** gugu-dev#181 我发出的一张卡(content_type='card',taskCardModels):不点名、不叫醒人。「已安排」那张由这里落。 */
  sendCardToChat(chatId: string, content: string): Promise<void>;
  /** gugu-dev#181 在这个对话里派任务记着的项目(这台设备上;这个对话没选过 = 最近一次选的)。 */
  rememberedTaskProject(chatId: string, deviceId: string): Promise<string | null>;
  rememberTaskProject(chatId: string, deviceId: string, projectId: string | null): Promise<void>;
}
