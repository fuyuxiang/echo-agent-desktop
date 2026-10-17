export const CAPABILITY_NAV_ITEMS = [
  { route: "专家·技能·连接器", title: "专家" },
  { route: "专家团", title: "专家团" },
  { route: "技能", title: "技能" },
  { route: "连接器", title: "连接器" },
  { route: "插件", title: "插件" },
] as const;

export function isCapabilityView(route: string): boolean {
  return CAPABILITY_NAV_ITEMS.some(item => item.route === route);
}
