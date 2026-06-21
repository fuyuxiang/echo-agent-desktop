/**
 * 页面生成器(npm run new:page)
 *
 * 交互输入页面名(PascalCase,如 Settings),自动生成四件套:
 * 1. src/renderer/src/pages/<Name>/index.tsx + <name>.module.scss
 * 2. src/renderer/src/services/<name>.ts
 * 3. src/renderer/src/mock/<name>.ts(并自动 import 进 mock/index.ts)
 * 4. 路由: constants/ROUTES 常量 + router 懒加载注册
 */
export default function (plop) {
  plop.setGenerator('page', {
    description: '生成页面四件套(page + service + mock + 路由)',
    prompts: [
      {
        type: 'input',
        name: 'name',
        message: '页面名(PascalCase,如 Settings / ChatHistory):',
        validate: (value) =>
          /^[A-Z][a-zA-Z0-9]*$/.test(value) || '必须是 PascalCase(大写字母开头,仅字母数字)'
      }
    ],
    actions: [
      // 1. 页面组件 + 样式
      {
        type: 'add',
        path: '../src/renderer/src/pages/{{pascalCase name}}/index.tsx',
        templateFile: 'plop-templates/page.tsx.hbs'
      },
      {
        type: 'add',
        path: '../src/renderer/src/pages/{{pascalCase name}}/{{camelCase name}}.module.scss',
        templateFile: 'plop-templates/page.module.scss.hbs'
      },
      // 2. service
      {
        type: 'add',
        path: '../src/renderer/src/services/{{camelCase name}}.ts',
        templateFile: 'plop-templates/service.ts.hbs'
      },
      // 3. mock + 自动注册
      {
        type: 'add',
        path: '../src/renderer/src/mock/{{camelCase name}}.ts',
        templateFile: 'plop-templates/mock.ts.hbs'
      },
      {
        type: 'append',
        path: '../src/renderer/src/mock/index.ts',
        pattern: /import '\.\/example'/,
        template: "import './{{camelCase name}}'"
      },
      // 4. 路由常量 + 路由注册
      {
        type: 'modify',
        path: '../src/renderer/src/constants/index.ts',
        pattern: /(\s*\/\/ plop-route-constant)/,
        template:
          ",\n  /** {{pascalCase name}} 页 */\n  {{camelCase name}}: '/{{kebabCase name}}'$1"
      },
      {
        type: 'modify',
        path: '../src/renderer/src/request/urls.ts',
        pattern: /(\s*\/\/ 新模块依葫芦画瓢:)/,
        template:
          ",\n  /** {{pascalCase name}} 模块 */\n  {{camelCase name}}: {\n    /** 获取 {{pascalCase name}} 数据 */\n    data: '/api/{{kebabCase name}}/data'\n  }$1"
      },
      {
        type: 'modify',
        path: '../src/renderer/src/router/index.tsx',
        pattern: /(\/\/ plop-page-import)/,
        template:
          "$1\nconst {{pascalCase name}}Page = lazy(() => import('@/pages/{{pascalCase name}}'))"
      },
      {
        type: 'modify',
        path: '../src/renderer/src/router/index.tsx',
        pattern: /(\s*\/\/ plop-route)/,
        template:
          ',\n      { path: ROUTES.{{camelCase name}}, element: lazyLoad(<{{pascalCase name}}Page />) }$1'
      },
      () => '完成!请到 i18n/locales 添加页面文案,然后照 pages/Example 开发页面即可'
    ]
  })
}
