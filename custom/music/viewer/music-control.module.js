/**
 * MAERS Music Control (music-control.module.js)
 * 播放控制逻辑 (Next/Prev)
 * 依赖: Player, UI (通过 import)
 * @version 3.0.0 - ES6 Module
 */

import { Utils } from '../../../shared/utils.module.js';

let Player, UI;

const ANIMATION_DELAY = 300;

export function initControl(playerModule, uiModule) {
    Player = playerModule;
    UI = uiModule;
}

// 分页映射与当前展开列表共用同一套下标，避免上一首、下一首发生偏移。
function pageMapping(album) {
    return album.page_mapping || Array.from({ length: parseInt(album.total) || 1 }, (_, i) => i + 1);
}

function isCurrentCollection({ catIdx, colIdx }) {
    return UI.currentLevel === 2 && catIdx === UI.currentCatIndex && colIdx === UI.currentColIndex;
}

function playPart(current, trackIdx, direction) {
    const { bvid, total, catIdx, colIdx, albIdx } = current;
    const album = UI.libraryData[catIdx].collections[colIdx].albums[albIdx];
    const page = pageMapping(album)[trackIdx];
    const title = album.custom_parts?.[trackIdx] || `P${page}`;
    let trackEl = null;
    if (isCurrentCollection(current)) {
        const dropdown = document.getElementById(`dropdown-${albIdx}`);
        if (dropdown?.classList.contains('active')) trackEl = dropdown.children[trackIdx];
    }
    Player.playTrack?.(bvid, page, total, catIdx, colIdx, albIdx, trackEl, trackIdx);
    Player.showTip?.(`${direction > 0 ? '⏭' : '⏮'} ${title}`);
}

function albumPosition(catIdx, colIdx, albIdx, level) {
    const category = UI.libraryData[catIdx];
    const collection = category?.collections[colIdx];
    const album = collection?.albums[albIdx];
    return album ? { catIdx, colIdx, albIdx, category, collection, album, level } : null;
}

function collectionBoundary(catIdx, colIdx, direction, level) {
    const collection = UI.libraryData[catIdx]?.collections[colIdx];
    const albIdx = direction > 0 ? 0 : (collection?.albums.length || 0) - 1;
    return albumPosition(catIdx, colIdx, albIdx, level);
}

function categoryBoundary(catIdx, direction, level) {
    const category = UI.libraryData[catIdx];
    const colIdx = direction > 0 ? 0 : (category?.collections.length || 0) - 1;
    return collectionBoundary(catIdx, colIdx, direction, level);
}

function loopPosition(direction) {
    if (direction > 0) return categoryBoundary(0, direction, 'loop');
    // 倒序循环沿用从队尾查找非空合集的规则。
    for (let catIdx = UI.libraryData.length - 1; catIdx >= 0; catIdx--) {
        for (let colIdx = UI.libraryData[catIdx].collections.length - 1; colIdx >= 0; colIdx--) {
            const position = collectionBoundary(catIdx, colIdx, direction, 'loop');
            if (position) return position;
        }
    }
    return null;
}

function adjacentAlbum(current, direction) {
    const { catIdx, colIdx, albIdx } = current;
    return albumPosition(catIdx, colIdx, albIdx + direction, 'album')
        || collectionBoundary(catIdx, colIdx + direction, direction, 'collection')
        || categoryBoundary(catIdx + direction, direction, 'category')
        || loopPosition(direction);
}

function enterPosition(position) {
    const { catIdx, colIdx, level } = position;
    if (level === 'collection') {
        if (UI.currentLevel >= 1) UI.enterLevel2?.(catIdx, colIdx);
    } else if (level === 'category' || level === 'loop') {
        UI.enterLevel1?.(catIdx);
        if (UI.enterLevel2) setTimeout(() => UI.enterLevel2(catIdx, colIdx), ANIMATION_DELAY);
    }
}

function positionTip({ level, album, collection, category }, direction) {
    if (level === 'album') return `${direction > 0 ? '下一视频' : '上一视频'}: ${album.title}`;
    if (level === 'collection') return `${direction > 0 ? '进入合集' : '上一合集'}: ${collection.name}`;
    if (level === 'category') return `${direction > 0 ? '进入分类' : '上一分类'}: ${category.name}`;
    return direction > 0 ? '循环播放: 回到开头' : '循环播放: 跳至队尾';
}

function movePlayback(direction) {
    const current = Player?.currentPlaying;
    if (!current?.bvid) {
        Player?.showTip?.('未播放歌曲');
        return;
    }
    const nextTrack = direction > 0 ? current.trackIdx + 1 : current.trackIdx - 1;
    if (current.trackIdx !== undefined && (direction > 0 ? nextTrack < current.total : nextTrack >= 0)) {
        playPart(current, nextTrack, direction);
        return;
    }
    const position = adjacentAlbum(current, direction);
    if (!position) return;
    const { album, catIdx, colIdx, albIdx } = position;
    const trackIdx = direction > 0 ? 0 : album.total - 1;
    enterPosition(position);
    Player.playTrack?.(album.bvid, pageMapping(album)[trackIdx], album.total,
        catIdx, colIdx, albIdx, null, trackIdx);
    if (position.level === 'album' && isCurrentCollection(position)) UI.renderAlbums?.(catIdx, colIdx);
    Player.showTip?.(positionTip(position, direction));
}

export function playNext() {
    movePlayback(1);
}

export function playPrev() {
    movePlayback(-1);
}

// 绑定播放器按钮
document.addEventListener('DOMContentLoaded', () => {
    Utils.bindEvent('#play-prev-btn', 'click', playPrev);
    Utils.bindEvent('#play-next-btn', 'click', playNext);
});
