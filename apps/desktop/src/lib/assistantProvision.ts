export { pickAssistant, type AssistantPick, type AssistantProvisionRow } from '@gugu/core/shared/assistantProvision'

/**
 * #7199 谁是这个人的「个人助理」(owner:「它是一个个人级别的 agent……只有一个身份」):
 * 开通的最后一步把它建出来时打的标记 —— `identity.agent_provisions` 里 `member_key='assistant'` 的那一行,`agent_user_id` 就是它。
 * 会员一键领取由管家在云上建、非会员在自己的电脑上建(owner 10-16「我们不强制用户使用云电脑」),两条走的是同一条链、同一个标记。
 * 认法 = 这个标记,❌ 按名字(它能改名)、❌ 按「住在云电脑上的第一个 agent」(人也能在云电脑上建别的 agent)、
 * ❌ 按住在哪台(它会搬家:会员到期搬回电脑、开了会员搬上云)。
 */
