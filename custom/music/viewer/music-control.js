/**
 * MAERS Music Control (music-control.js)
 * 播放控制逻辑 (Next/Prev)
 * 依赖: MAERS.Music.Player, MAERS.Music.UI
 * @version 2.0.0
 */
(function (global) {
    'use strict';

    global.MAERS = global.MAERS || {};
    MAERS.Music = MAERS.Music || {};

    function playNext() {
        const Player = MAERS.Music.Player;
        const UI = MAERS.Music.UI;

        if (!Player || !Player.currentPlaying || !Player.currentPlaying.bvid) {
            if (Player && Player.showTip) Player.showTip("未播放歌曲");
            return;
        }

        const { bvid, total, catIdx, colIdx, albIdx, trackIdx } = Player.currentPlaying;

        // 1. 分P: 如果还有下一P
        if (trackIdx !== undefined && trackIdx + 1 < total) {
            const nextTrackIdx = trackIdx + 1;
            const album = UI.libraryData[catIdx].collections[colIdx].albums[albIdx];
            const totalP = parseInt(album.total) || 1;
            const mapping = album.page_mapping || Array.from({ length: totalP }, (_, k) => k + 1);

            const nextPage = mapping[nextTrackIdx];
            const nextTitle = (album.custom_parts && album.custom_parts[nextTrackIdx]) || `P${nextPage}`;

            let nextEl = null;
            if (UI.currentLevel === 2 && catIdx === UI.currentCatIndex && colIdx === UI.currentColIndex) {
                const dropdown = document.getElementById(`dropdown-${albIdx}`);
                if (dropdown && dropdown.classList.contains('active')) nextEl = dropdown.children[nextTrackIdx];
            }
            if (Player.playTrack) Player.playTrack(bvid, nextPage, total, catIdx, colIdx, albIdx, nextEl, nextTrackIdx);
            if (Player.showTip) Player.showTip(`⏭ ${nextTitle}`);
            return;
        }

        // 2. 合集: 如果还有下一个视频
        const currentCol = UI.libraryData[catIdx].collections[colIdx];
        if (currentCol && albIdx + 1 < currentCol.albums.length) {
            const nextAlbIdx = albIdx + 1;
            const nextAlbum = currentCol.albums[nextAlbIdx];
            const totalP = parseInt(nextAlbum.total) || 1;
            const nextMapping = nextAlbum.page_mapping || Array.from({ length: totalP }, (_, k) => k + 1);
            if (Player.playTrack) Player.playTrack(nextAlbum.bvid, nextMapping[0], nextAlbum.total, catIdx, colIdx, nextAlbIdx, null, 0);
            if (UI.currentLevel === 2 && catIdx === UI.currentCatIndex && colIdx === UI.currentColIndex && UI.renderAlbums) {
                UI.renderAlbums(catIdx, colIdx);
            }
            if (Player.showTip) Player.showTip(`下一视频: ${nextAlbum.title}`);
            return;
        }

        // 3. 分类: 如果还有下一个合集
        const currentCat = UI.libraryData[catIdx];
        if (currentCat && colIdx + 1 < currentCat.collections.length) {
            const nextColIdx = colIdx + 1;
            const nextCol = currentCat.collections[nextColIdx];
            if (nextCol.albums.length > 0) {
                const nextAlbum = nextCol.albums[0];
                if (UI.currentLevel >= 1 && UI.enterLevel2) UI.enterLevel2(catIdx, nextColIdx);
                const totalP = parseInt(nextAlbum.total) || 1;
                const nextMapping = nextAlbum.page_mapping || Array.from({ length: totalP }, (_, k) => k + 1);
                if (Player.playTrack) Player.playTrack(nextAlbum.bvid, nextMapping[0], nextAlbum.total, catIdx, nextColIdx, 0, null, 0);
                if (Player.showTip) Player.showTip(`进入合集: ${nextCol.name}`);
                return;
            }
        }

        // 4. 库: 如果还有下一个分类
        if (catIdx + 1 < UI.libraryData.length) {
            const nextCatIdx = catIdx + 1;
            const nextCat = UI.libraryData[nextCatIdx];
            if (nextCat.collections.length > 0) {
                const nextCol = nextCat.collections[0];
                if (nextCol.albums.length > 0) {
                    const nextAlbum = nextCol.albums[0];
                    if (UI.enterLevel1) UI.enterLevel1(nextCatIdx);
                    if (UI.enterLevel2) setTimeout(() => UI.enterLevel2(nextCatIdx, 0), 300);
                    const totalP = parseInt(nextAlbum.total) || 1;
                    const nextMapping = nextAlbum.page_mapping || Array.from({ length: totalP }, (_, k) => k + 1);
                    if (Player.playTrack) Player.playTrack(nextAlbum.bvid, nextMapping[0], nextAlbum.total, nextCatIdx, 0, 0, null, 0);
                    if (Player.showTip) Player.showTip(`进入分类: ${nextCat.name}`);
                    return;
                }
            }
        }

        // 5. 循环: 回到第一个视频
        if (UI.libraryData.length > 0) {
            const first = UI.libraryData[0].collections[0].albums[0];
            if (UI.enterLevel1) UI.enterLevel1(0);
            if (UI.enterLevel2) setTimeout(() => UI.enterLevel2(0, 0), 300);
            const totalP = parseInt(first.total) || 1;
            const nextMapping = first.page_mapping || Array.from({ length: totalP }, (_, k) => k + 1);
            if (Player.playTrack) Player.playTrack(first.bvid, nextMapping[0], first.total, 0, 0, 0, null, 0);
            if (Player.showTip) Player.showTip("循环播放: 回到开头");
        }
    }

    function playPrev() {
        const Player = MAERS.Music.Player;
        const UI = MAERS.Music.UI;

        if (!Player || !Player.currentPlaying || !Player.currentPlaying.bvid) {
            if (Player && Player.showTip) Player.showTip("未播放歌曲");
            return;
        }

        const { bvid, total, catIdx, colIdx, albIdx, trackIdx } = Player.currentPlaying;

        // 1. 分P: 如果有上一P
        if (trackIdx !== undefined && trackIdx > 0) {
            const prevTrackIdx = trackIdx - 1;
            const album = UI.libraryData[catIdx].collections[colIdx].albums[albIdx];
            const totalP = parseInt(album.total) || 1;
            const mapping = album.page_mapping || Array.from({ length: totalP }, (_, k) => k + 1);

            const prevPage = mapping[prevTrackIdx];
            const prevTitle = (album.custom_parts && album.custom_parts[prevTrackIdx]) || `P${prevPage}`;

            let prevEl = null;
            if (UI.currentLevel === 2 && catIdx === UI.currentCatIndex && colIdx === UI.currentColIndex) {
                const dropdown = document.getElementById(`dropdown-${albIdx}`);
                if (dropdown && dropdown.classList.contains('active')) prevEl = dropdown.children[prevTrackIdx];
            }
            if (Player.playTrack) Player.playTrack(bvid, prevPage, total, catIdx, colIdx, albIdx, prevEl, prevTrackIdx);
            if (Player.showTip) Player.showTip(`⏮ ${prevTitle}`);
            return;
        }

        // 2. 合集: 如果有上一个视频
        const currentCol = UI.libraryData[catIdx].collections[colIdx];
        if (currentCol && albIdx > 0) {
            const prevAlbIdx = albIdx - 1;
            const prevAlbum = currentCol.albums[prevAlbIdx];
            const totalP = parseInt(prevAlbum.total) || 1;
            const prevMapping = prevAlbum.page_mapping || Array.from({ length: totalP }, (_, k) => k + 1);
            const lastTrackIdx = prevAlbum.total - 1;
            if (Player.playTrack) Player.playTrack(prevAlbum.bvid, prevMapping[lastTrackIdx], prevAlbum.total, catIdx, colIdx, prevAlbIdx, null, lastTrackIdx);
            if (UI.currentLevel === 2 && catIdx === UI.currentCatIndex && colIdx === UI.currentColIndex && UI.renderAlbums) {
                UI.renderAlbums(catIdx, colIdx);
            }
            if (Player.showTip) Player.showTip(`上一视频: ${prevAlbum.title}`);
            return;
        }

        // 3. 分类: 如果有上一个合集
        const currentCat = UI.libraryData[catIdx];
        if (currentCat && colIdx > 0) {
            const prevColIdx = colIdx - 1;
            const prevCol = currentCat.collections[prevColIdx];
            if (prevCol.albums.length > 0) {
                const lastAlbIdx = prevCol.albums.length - 1;
                const lastAlbum = prevCol.albums[lastAlbIdx];
                if (UI.currentLevel >= 1 && UI.enterLevel2) UI.enterLevel2(catIdx, prevColIdx);

                const totalP = parseInt(lastAlbum.total) || 1;
                const lastMapping = lastAlbum.page_mapping || Array.from({ length: totalP }, (_, k) => k + 1);
                const lastTrackIdx = lastAlbum.total - 1;
                if (Player.playTrack) Player.playTrack(lastAlbum.bvid, lastMapping[lastTrackIdx], lastAlbum.total, catIdx, prevColIdx, lastAlbIdx, null, lastTrackIdx);
                if (Player.showTip) Player.showTip(`上一合集: ${prevCol.name}`);
                return;
            }
        }

        // 4. 库: 如果有上一个分类
        if (catIdx > 0) {
            const prevCatIdx = catIdx - 1;
            const prevCat = UI.libraryData[prevCatIdx];
            if (prevCat.collections.length > 0) {
                const lastColIdx = prevCat.collections.length - 1;
                const lastCol = prevCat.collections[lastColIdx];
                if (lastCol.albums.length > 0) {
                    const lastAlbIdx = lastCol.albums.length - 1;
                    const lastAlbum = lastCol.albums[lastAlbIdx];
                    if (UI.enterLevel1) UI.enterLevel1(prevCatIdx);
                    if (UI.enterLevel2) setTimeout(() => UI.enterLevel2(prevCatIdx, lastColIdx), 300);

                    const totalP = parseInt(lastAlbum.total) || 1;
                    const lastMapping = lastAlbum.page_mapping || Array.from({ length: totalP }, (_, k) => k + 1);
                    const lastTrackIdx = lastAlbum.total - 1;
                    if (Player.playTrack) Player.playTrack(lastAlbum.bvid, lastMapping[lastTrackIdx], lastAlbum.total, prevCatIdx, lastColIdx, lastAlbIdx, null, lastTrackIdx);
                    if (Player.showTip) Player.showTip(`上一分类: ${prevCat.name}`);
                    return;
                }
            }
        }

        // 5. 循环: 跳到最后一个
        for (let i = UI.libraryData.length - 1; i >= 0; i--) {
            const cat = UI.libraryData[i];
            if (cat.collections.length > 0) {
                for (let j = cat.collections.length - 1; j >= 0; j--) {
                    const col = cat.collections[j];
                    if (col.albums.length > 0) {
                        const lastAlbIdx = col.albums.length - 1;
                        const lastAlbum = col.albums[lastAlbIdx];
                        if (UI.enterLevel1) UI.enterLevel1(i);
                        if (UI.enterLevel2) setTimeout(() => UI.enterLevel2(i, j), 300);

                        const totalP = parseInt(lastAlbum.total) || 1;
                        const lastMapping = lastAlbum.page_mapping || Array.from({ length: totalP }, (_, k) => k + 1);
                        const lastTrackIdx = lastAlbum.total - 1;
                        if (Player.playTrack) Player.playTrack(lastAlbum.bvid, lastMapping[lastTrackIdx], lastAlbum.total, i, j, lastAlbIdx, null, lastTrackIdx);
                        if (Player.showTip) Player.showTip("循环播放: 跳至队尾");
                        return;
                    }
                }
            }
        }
    }

    // Mount to namespace
    MAERS.Music.Control = {
        playNext,
        playPrev
    };

})(typeof window !== 'undefined' ? window : this);
