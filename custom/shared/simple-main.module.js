/**
 * MAERS Simple Page Entry Point
 * Used for static pages like Me, Space, Games.
 * @version 1.0.0
 */

// 0. Shared Utilities
// import { Utils, Search as UrlSearch } from '../../shared/utils.module.js'; // Utils no longer passed globally

// 1. UI Infrastructure
import { initLayout, renderPageHeader } from './ui/layout.module.js';
import { initTheme } from './ui/theme.module.js';

// A. Mount Utilities
// window.MAERS removal

// B. Initialize Core UI
initLayout();
initTheme();

// Export for usage in HTML files
export { renderPageHeader };




