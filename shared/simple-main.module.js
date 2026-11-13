/** 轻量页面入口：为个人简介和动态新建页面初始化公共布局与主题。 */
import { initLayout, renderPageHeader } from './layout.module.js';
import { initTheme } from './theme.module.js';

initLayout();
initTheme();

export { renderPageHeader };
