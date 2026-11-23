import { Document, Share, Search, ChatDotRound } from '@element-plus/icons-vue'
import { CubeIcon } from '@/shared/ui/icons'

export const NAV_MENUS = [
  {
    index: 'kb',
    labelKey: 'modules.kb.kb',
    children: [
      {
        index: '/knowledge',
        labelKey: 'modules.kb.dockb',
        iconComponent: Document,
        route: { path: '/knowledge' }
      },
      {
        index: '/graph',
        labelKey: 'modules.kb.graphKnowledgeBase',
        iconComponent: Share,
        route: { path: '/graph' }
      },
      {
        index: '/flow',
        labelKey: 'ragFlow.ragWorkflow',
        iconComponent: Search,
        route: { path: '/flow' }
      },
      {
        index: '/chat',
        labelKey: 'nav.chat',
        iconComponent: ChatDotRound,
        route: { path: '/chat' }
      }
    ]
  },
  {
    index: '/models',
    labelKey: 'nav.modelManagement',
    iconComponent: CubeIcon,
    route: { path: '/models' }
  }
]

export function resolveActiveMenu (path) {
  return NAV_MENUS.flatMap(menu => menu.children ?? [menu]).find(({ index }) => (
    path === index || path.startsWith(index + '/')
  ))?.index ?? path
}
