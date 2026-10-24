/** Facts supplied to the synthetic world. Missing historical inputs must not force invention. */
export const fixtureInputs: Record<string, Record<string, string>> = {
  'research-monitor': {
    'inputs/competitors-v1.md': '# 上轮记录 V1（虚构）\n2026-10-14，记录 A1：竞品A支持浏览、不支持导出。记录 B1：竞品B支持PDF导出。范围仅为导出功能，不推断其他能力。',
    'inputs/competitors-v2.md': '# 本轮记录 V2（虚构）\n2026-10-21，记录 A2：竞品A新增PDF导出，CSV仍未支持。记录 B2：竞品B的PDF导出没有变化。均为隔离输入，不能当真实市场信息。',
  },
  'meeting-project': {
    'launch/README.md': '# 发布准备\n上次讨论见 meeting-20261020.md；只准备内部会前材料与会后跟进模板，不发邀请、不改日程。',
    'launch/meeting-20261020.md': '# 2026-10-20 讨论（虚构）\nM-01：本周五评审核心功能发布草案。已决定中文正文18pt。未结：小林复验离线兼容性；小周核对预算3200元，尚未批准。会后模板须分决定、负责人、截止与来源。',
  },
  'content-package': {
    'launch/README.md': '# 品牌素材\n活动：纸舟离线笔记体验，10月30日14时，线上内部演示；主张本地笔记、清晰可读。使用 brand/brief.md 与 brand/mark.svg，不许承诺效率提升，不对外发布。',
    'launch/brand/brief.md': '# 品牌资料（虚构）\nB-01：名称纸舟，主色蓝；体验内容为离线笔记和文件导出。B-02：内测报名仅收意向，不承诺上线日期、费用或效率收益。B-03：群聊文案两句，邮件草稿含主题与正文；设计保留标志留白、深色字、替代文本。',
    'launch/brand/mark.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 40"><title>纸舟标志</title><path fill="#1659b7" d="M0 0L80 0L40 40Z"/></svg>',
  },
  'specialist-handoff': {
    'launch/README.md': '# 发布准备（虚构）\n本轮材料见 market.md 与 usage.csv。预算12000元替代旧草案10000元，内部评审，不发布、不付款。交中文研究、分析与三页演示稿，来源逐项对应。',
    'launch/market.md': '# 研究记录\nR-01：竞品A离线笔记19元/月，导出PDF；R-02：竞品B39元/月支持团队同步，离线能力未知。R-03：纸舟可离线编辑、委派任务，定价未知；尚无效率收益证据。全部为虚构输入。',
    'launch/usage.csv': 'cohort,users,paid,revenue\nsolo,80,8,232\nteam,40,14,686\n',
  },
}
