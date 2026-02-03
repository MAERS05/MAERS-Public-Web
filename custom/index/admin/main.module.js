/**
 * MAERS Admin Panel Main Entry
 * @version 1.0.0 - ES6 Module
 */

// 0. Shared Utilities
import { Utils, Search as UrlSearch } from '../../../shared/utils.module.js';

// 1. UI Infrastructure
import { initLayout } from '../../shared/ui/layout.module.js';
import { initTheme } from '../../shared/ui/theme.module.js';

// 2. Admin Core
import { Admin } from './admin-core.module.js';

// --- Initialization ---

// Utils is now imported directly by modules that need it

// B. Init UI
initLayout();
initTheme();

// C. Initialize Admin System
document.addEventListener('DOMContentLoaded', () => {
    // Init Admin Logic
    Admin.init();

    // Splash Screen Control removed
});
