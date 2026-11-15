/** CMS 管理入口：选择模块专属视图，其余启动与保存流程共用。 */
import { initCmsPage } from './viewer/cms-page.module.js';
import { Controller } from './admin/cms-controller.module.js';
import { GamesView } from '../games/viewer/games-view.module.js';
import { injectModuleStyle } from '../../shared/style-injector.module.js';

const module = Controller.CONFIG.CURRENT_MODULE;
injectModuleStyle(module);
document.body.classList.toggle('cms-text-admin', module === 'notes' || module === 'record');
initCmsPage({ customView: module === 'games' ? GamesView : null });
