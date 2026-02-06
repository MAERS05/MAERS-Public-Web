/**
 * @module custom/cms/viewer/cms-tags.module.js
 * @description CMS 标签系统 - 主入口模块（整合子模块）
 * @version 4.0.0 - ES6 Module (Modularized)
 */

import * as TagsDrawer from './tags/cms-tags-drawer.module.js';
import * as TagsFilter from './tags/cms-tags-filter.module.js';
import * as TagsAdmin from '../admin/cms-tags-admin.module.js';

// Dependency injection
let State = null;
let Controller = null;
let Search = null;

export function initTags(state, controller, search) {
    State = state;
    Controller = controller;
    Search = search;

    // Initialize sub-modules
    TagsFilter.initFilter({ State, Search });
    TagsAdmin.initAdmin({ State, Controller });
}

export function toggleTagDrawer() {
    TagsDrawer.toggleTagDrawer(
        () => TagsAdmin.initManager(refreshDrawerList),
        refreshDrawerList
    );
}


export function refreshDrawerList() {
    // Prepare dependencies for drawer
    const deps = {
        State,
        Controller,
        categoryManager: TagsAdmin.getManager(),
        selectedTags: TagsAdmin.selectedTags,
        expandedCategories: TagsAdmin.expandedCategories,
        filterByTag: filterByTagInternal,
        handleMoveTags: handleMoveTagsInternal,
        uiSort: uiSortInternal,
        uiEdit: uiEditInternal,
        uiDelete: uiDeleteInternal,
        createCategory: createCategoryInternal
    };

    TagsDrawer.initDrawer(deps);
    TagsDrawer.refreshDrawerList(TagsAdmin.updateManagerReference);
}

function filterByTagInternal(e, tag) {
    TagsFilter.filterByTag(e, tag);
    refreshDrawerList();
}

function handleMoveTagsInternal(tagNames, targetCategoryName) {
    TagsAdmin.handleMoveTags(tagNames, targetCategoryName, refreshDrawerList);
}

function uiEditInternal(index, e) {
    TagsAdmin.uiEdit(index, e);
    refreshDrawerList();
}

function uiDeleteInternal(index, e) {
    TagsAdmin.uiDelete(index, e);
    refreshDrawerList();
}

function createCategoryInternal() {
    TagsAdmin.createCategory(refreshDrawerList);
}

export function filterByTag(e, tag) {
    filterByTagInternal(e, tag);
}

export function clearTagFilter() {
    TagsFilter.clearTagFilter();
    refreshDrawerList();
}

export function selectTagFromDrawer(tag) {
    TagsFilter.selectTagFromDrawer(tag);
    refreshDrawerList();
}

export function getManager() {
    return TagsAdmin.getManager();
}

export async function tagPerformSave() {
    await TagsAdmin.tagPerformSave();
    refreshDrawerList();
}

export async function tagPerformCancel() {
    await TagsAdmin.tagPerformCancel();
    refreshDrawerList();
}

export function uiSort(index, e) {
    uiSortInternal(index, e);
}

function uiSortInternal(index, e) {
    TagsAdmin.uiSort(index, e);
    refreshDrawerList();
}

export function uiMoveTo(index, e) {
    TagsAdmin.uiMoveTo(index, e);
}

export function uiEdit(index, e) {
    uiEditInternal(index, e);
}

export function uiDelete(index, e) {
    uiDeleteInternal(index, e);
}

export const Tags = {
    filterByTag,
    toggleTagDrawer,
    refreshDrawerList,
    selectTagFromDrawer,
    clearTagFilter,
    getManager,
    uiSort,
    uiMoveTo,
    uiEdit,
    uiDelete,
    tagPerformSave,
    tagPerformCancel
};
