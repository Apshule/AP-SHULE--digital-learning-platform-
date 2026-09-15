/* APSHULE offline storage and synchronisation core.
 *
 * This file intentionally has no Firebase, framework, or bundler dependency.  It
 * is safe to load before the application and exposes one small browser global.
 */
(function (root) {
  'use strict';

  var DB_NAME = 'appshule-offline';
  var DB_VERSION = 22;
  var STORE_NAMES = [
    'offline_videos',
    'offline_ca_records',
    'offline_projects',
    'offline_auth',
    'offline_views',
    'offline_settings',
    'offline_curriculum_links',
    'offline_favorites',
    'offline_recent_curriculum',
    'offline_ncdc_modules',
    'offline_teacher_progress',
    'offline_video_studio',
    'offline_pdfs',
    'offline_sync_history',
    'offline_branding',
    'offline_command_stats',
    'offline_mfi_customers',
    'offline_mfi_collateral',
    'offline_mfi_verification',
    'offline_mfi_portfolio',
    'offline_mfi_reports',
    'offline_mfi_loans',
    'offline_mfi_loan_payments',
    'offline_clinic_visits',
    'offline_clinic_prescriptions',
    'offline_clinic_checkins',
    'offline_clinic_inventory',
    'offline_clinic_product_scans',
    'offline_clinic_dispensing',
    'offline_clinic_billing',
    'offline_clinic_payments',
    'offline_clinic_claims',
    'offline_clinic_dashboard',
    'offline_farm_movements',
    'offline_farm_attendance',
    'offline_farm_reports',
    'offline_farm_egg_collections',
    'offline_farm_feed_consumption',
    'offline_farm_inventory'
  ];
  var FALLBACK_KEY = '__connection__';
  var TEMPLATE_PREFIX = '__ncdc_template__:';
  var VALID_MODES = ['offline', 'mobile', 'wifi'];
  var DEFAULT_SETTINGS = {
    dataSaverMode: false,
    autoDownloadWifi: true,
    downloadHdWifiOnly: true,
    languagePreference: 'English',
    videoLanguage: 'English',
    usageMonth: new Date().toISOString().slice(0, 7),
    downloadedBytes: 0,
    uploadedBytes: 0,
    lastSyncBytes: 0,
    lastSyncAt: null,
    autoSyncWifi: true,
    autoSyncMobile: false
  };
  var dbPromise;
  var syncHooks = {};
  var modeListeners = [];
  var lastMode;
  var VIEW_DEVICE_TYPES = ['phone', 'tablet', 'laptop', 'desktop'];
  var VIEW_CONNECTION_MODES = ['offline', 'mobile_data', 'wifi'];

  function fail(message) {
    return Promise.reject(new Error(message));
  }

  function hasIndexedDb() {
    return !!(root && root.indexedDB);
  }

  function deviceType() {
    var userAgent = String((root.navigator && root.navigator.userAgent) || '').toLowerCase();
    if (/ipad|tablet|playbook|silk/.test(userAgent)) return 'tablet';
    if (/mobile|iphone|android/.test(userAgent)) return 'phone';
    if (/macintosh|windows|linux|cros/.test(userAgent)) return 'desktop';
    return 'desktop';
  }

  function viewDate(value) {
    var date = value ? new Date(value) : new Date();
    if (isNaN(date.getTime())) date = new Date();
    return date.toISOString().slice(0, 10);
  }

  function viewIdFor(value) {
    var studentId = String(value.studentId || 'unknown-student');
    var videoId = String(value.videoId || value.videoKey || 'unknown-video');
    return studentId + '_' + videoId + '_' + viewDate(value.watchedAt || value.queuedAt);
  }

  function numberOr(value, fallback) {
    var number = Number(value);
    return isFinite(number) && number >= 0 ? number : fallback;
  }

  function normalizeOfflineView(view) {
    view = view || {};
    var watchedSeconds = numberOr(view.watchedSeconds, numberOr(view.currentTime, 0));
    var videoDuration = numberOr(view.videoDuration, numberOr(view.duration, 0));
    var completionPercent = videoDuration > 0 ? (watchedSeconds / videoDuration) * 100 : 0;
    var requestedDeviceType = String(view.deviceType || '').toLowerCase();
    var requestedConnectionMode = String(view.connectionMode || '').toLowerCase();
    if (requestedConnectionMode === 'mobile') requestedConnectionMode = 'mobile_data';
    return Object.assign({}, view, {
      viewId: view.viewId || viewIdFor(view),
      videoId: view.videoId || view.videoKey || '',
      teacherId: view.teacherId || '',
      studentId: view.studentId || '',
      studentName: view.studentName || '',
      watchedSeconds: watchedSeconds,
      videoDuration: videoDuration,
      completionPercent: completionPercent,
      completed: view.completed === true || completionPercent >= 90,
      synced: typeof view.synced === 'boolean' ? view.synced : false,
      schoolId: view.schoolId || '',
      deviceType: VIEW_DEVICE_TYPES.indexOf(requestedDeviceType) >= 0 ? requestedDeviceType : deviceType(),
      watchedAt: view.watchedAt || new Date().toISOString(),
      connectionMode: VIEW_CONNECTION_MODES.indexOf(requestedConnectionMode) >= 0 ? requestedConnectionMode : 'offline',
      earningsAmount: numberOr(view.earningsAmount, 0)
    });
  }

  function isCompletedView(view) {
    return !!view && (view.completed === true || Number(view.completionPercent || 0) >= 90);
  }

  function ensureStoreIndexes(name, store) {
    if (name === 'offline_projects' && !store.indexNames.contains('syncStatus')) store.createIndex('syncStatus', 'syncStatus', { unique: false });
    if (name === 'offline_views' && !store.indexNames.contains('synced')) store.createIndex('synced', 'synced', { unique: false });
    if (name === 'offline_ca_records' && !store.indexNames.contains('synced')) store.createIndex('synced', 'synced', { unique: false });
    if (name === 'offline_videos' && !store.indexNames.contains('cached')) store.createIndex('cached', 'cached', { unique: false });
    if (name === 'offline_curriculum_links' && !store.indexNames.contains('subject')) store.createIndex('subject', 'subject', { unique: false });
    if (name === 'offline_curriculum_links' && !store.indexNames.contains('classLevel')) store.createIndex('classLevel', 'classLevel', { unique: false });
  }

  function migrateOfflineViewsStore(store) {
    var cursorRequest = store.openCursor();
    cursorRequest.onsuccess = function (event) {
      var cursor = event.target.result;
      if (!cursor) return;
      cursor.update(normalizeOfflineView(cursor.value));
      cursor.continue();
    };
  }

  function openDatabase() {
    if (!hasIndexedDb()) return fail('IndexedDB is not available in this browser');
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var request;
      try {
        request = root.indexedDB.open(DB_NAME, DB_VERSION);
      } catch (error) {
        reject(error);
        return;
      }
      request.onupgradeneeded = function (event) {
        var db = event.target.result;
        var oldVersion = event.oldVersion || 0;
        if (oldVersion < 2) STORE_NAMES.forEach(function (name) {
          var store;
          if (!db.objectStoreNames.contains(name)) {
            var keyPath = {
              offline_videos: 'videoId',
              offline_ca_records: 'recordId',
              offline_projects: 'localId',
              offline_auth: 'userId',
              offline_views: 'viewId',
              offline_settings: 'userId',
               offline_curriculum_links: 'docId',
               offline_favorites: 'favoriteKey',
               offline_recent_curriculum: 'docId',
               offline_ncdc_modules: 'moduleNumber',
                offline_teacher_progress: 'progressKey',
                offline_video_studio: 'libraryId',
                offline_pdfs: 'pdfId',
                 offline_sync_history: 'historyId',
                 offline_branding: 'institutionId',
                 offline_command_stats: 'statsKey',
                 offline_mfi_customers: 'localId',
                 offline_mfi_collateral: 'localId',
                  offline_mfi_verification: 'localId',
                  offline_mfi_portfolio: 'institutionId',
                   offline_mfi_reports: 'localId',
                   offline_clinic_visits: 'localId',
                   offline_clinic_prescriptions: 'localId',
                   offline_clinic_checkins: 'localId',
                   offline_clinic_inventory: 'localId',
                   offline_clinic_product_scans: 'localId',
                   offline_clinic_dispensing: 'localId',
                   offline_clinic_billing: 'localId',
                   offline_clinic_payments: 'localId',
                    offline_clinic_claims: 'localId',
                    offline_clinic_dashboard: 'institutionId',
                    offline_farm_egg_collections: 'localId',
                    offline_farm_feed_consumption: 'localId',
                    offline_farm_inventory: 'itemId'
            }[name];
            store = db.createObjectStore(name, { keyPath: keyPath });
          } else {
            store = event.target.transaction.objectStore(name);
          }
          ensureStoreIndexes(name, store);
        });
        if (oldVersion < 3) {
          var viewsStore = event.target.transaction.objectStore('offline_views');
          ensureStoreIndexes('offline_views', viewsStore);
          migrateOfflineViewsStore(viewsStore);
        }
        if (oldVersion < 5) {
          var curriculumStore;
          if (!db.objectStoreNames.contains('offline_curriculum_links')) {
            curriculumStore = db.createObjectStore('offline_curriculum_links', { keyPath: 'docId' });
          } else {
            curriculumStore = event.target.transaction.objectStore('offline_curriculum_links');
          }
          ensureStoreIndexes('offline_curriculum_links', curriculumStore);
        }
        if (oldVersion < 6) {
          var favoritesStore = db.objectStoreNames.contains('offline_favorites')
            ? event.target.transaction.objectStore('offline_favorites')
            : db.createObjectStore('offline_favorites', { keyPath: 'favoriteKey' });
          if (!favoritesStore.indexNames.contains('userId')) favoritesStore.createIndex('userId', 'userId', { unique: false });
          if (!favoritesStore.indexNames.contains('syncStatus')) favoritesStore.createIndex('syncStatus', 'syncStatus', { unique: false });
          var recentStore = db.objectStoreNames.contains('offline_recent_curriculum')
            ? event.target.transaction.objectStore('offline_recent_curriculum')
            : db.createObjectStore('offline_recent_curriculum', { keyPath: 'docId' });
          if (!recentStore.indexNames.contains('viewedAt')) recentStore.createIndex('viewedAt', 'viewedAt', { unique: false });
        }
        if (oldVersion < 7) {
          var modulesStore = db.objectStoreNames.contains('offline_ncdc_modules')
            ? event.target.transaction.objectStore('offline_ncdc_modules')
            : db.createObjectStore('offline_ncdc_modules', { keyPath: 'moduleNumber' });
          if (!modulesStore.indexNames.contains('isPublished')) modulesStore.createIndex('isPublished', 'isPublished', { unique: false });
          var progressStore = db.objectStoreNames.contains('offline_teacher_progress')
            ? event.target.transaction.objectStore('offline_teacher_progress')
            : db.createObjectStore('offline_teacher_progress', { keyPath: 'progressKey' });
          if (!progressStore.indexNames.contains('teacherId')) progressStore.createIndex('teacherId', 'teacherId', { unique: false });
          if (!progressStore.indexNames.contains('moduleNumber')) progressStore.createIndex('moduleNumber', 'moduleNumber', { unique: false });
        }
        if (oldVersion < 8) {
          var videoStudioStore = db.objectStoreNames.contains('offline_video_studio')
            ? event.target.transaction.objectStore('offline_video_studio')
            : db.createObjectStore('offline_video_studio', { keyPath: 'libraryId' });
          if (!videoStudioStore.indexNames.contains('subject')) videoStudioStore.createIndex('subject', 'subject', { unique: false });
          if (!videoStudioStore.indexNames.contains('language')) videoStudioStore.createIndex('language', 'language', { unique: false });
          if (!videoStudioStore.indexNames.contains('publishedAt')) videoStudioStore.createIndex('publishedAt', 'publishedAt', { unique: false });
        }
        if (oldVersion < 9 && !db.objectStoreNames.contains('offline_pdfs')) {
          var pdfStore = db.createObjectStore('offline_pdfs', { keyPath: 'pdfId' });
          pdfStore.createIndex('cachedAt', 'cachedAt', { unique: false });
        }
        if (oldVersion < 10 && !db.objectStoreNames.contains('offline_sync_history')) {
          var syncHistoryStore = db.createObjectStore('offline_sync_history', { keyPath: 'historyId' });
          syncHistoryStore.createIndex('userId', 'userId', { unique: false });
          syncHistoryStore.createIndex('completedAt', 'completedAt', { unique: false });
        }
        if (oldVersion < 11 && !db.objectStoreNames.contains('offline_branding')) {
          var brandingStore = db.createObjectStore('offline_branding', { keyPath: 'institutionId' });
          brandingStore.createIndex('cachedAt', 'cachedAt', { unique: false });
        }
        if (oldVersion < 12 && !db.objectStoreNames.contains('offline_command_stats')) {
          var commandStatsStore = db.createObjectStore('offline_command_stats', { keyPath: 'statsKey' });
          commandStatsStore.createIndex('cachedAt', 'cachedAt', { unique: false });
        }
        if (oldVersion < 14 && !db.objectStoreNames.contains('offline_mfi_verification')) {
          var verificationStore = db.createObjectStore('offline_mfi_verification', { keyPath: 'localId' });
          verificationStore.createIndex('institutionId', 'institutionId', { unique: false });
          verificationStore.createIndex('syncStatus', 'syncStatus', { unique: false });
        }
        if (oldVersion < 13) {
          var mfiCustomerStore = db.objectStoreNames.contains('offline_mfi_customers')
            ? event.target.transaction.objectStore('offline_mfi_customers')
            : db.createObjectStore('offline_mfi_customers', { keyPath: 'localId' });
          if (!mfiCustomerStore.indexNames.contains('institutionId')) mfiCustomerStore.createIndex('institutionId', 'institutionId', { unique: false });
          if (!mfiCustomerStore.indexNames.contains('syncStatus')) mfiCustomerStore.createIndex('syncStatus', 'syncStatus', { unique: false });
          var mfiCollateralStore = db.objectStoreNames.contains('offline_mfi_collateral')
            ? event.target.transaction.objectStore('offline_mfi_collateral')
            : db.createObjectStore('offline_mfi_collateral', { keyPath: 'localId' });
          if (!mfiCollateralStore.indexNames.contains('institutionId')) mfiCollateralStore.createIndex('institutionId', 'institutionId', { unique: false });
          if (!mfiCollateralStore.indexNames.contains('syncStatus')) mfiCollateralStore.createIndex('syncStatus', 'syncStatus', { unique: false });
        }
        if (oldVersion < 15) {
          var portfolioStore = db.objectStoreNames.contains('offline_mfi_portfolio')
            ? event.target.transaction.objectStore('offline_mfi_portfolio')
            : db.createObjectStore('offline_mfi_portfolio', { keyPath: 'institutionId' });
          if (!portfolioStore.indexNames.contains('updatedAt')) portfolioStore.createIndex('updatedAt', 'updatedAt', { unique: false });
          var reportStore = db.objectStoreNames.contains('offline_mfi_reports')
            ? event.target.transaction.objectStore('offline_mfi_reports')
            : db.createObjectStore('offline_mfi_reports', { keyPath: 'localId' });
          if (!reportStore.indexNames.contains('institutionId')) reportStore.createIndex('institutionId', 'institutionId', { unique: false });
          if (!reportStore.indexNames.contains('createdAt')) reportStore.createIndex('createdAt', 'createdAt', { unique: false });
        }
        if (oldVersion < 16) {
          ['offline_clinic_visits', 'offline_clinic_prescriptions', 'offline_clinic_checkins'].forEach(function (name) {
            var store = db.objectStoreNames.contains(name)
              ? event.target.transaction.objectStore(name)
              : db.createObjectStore(name, { keyPath: 'localId' });
            if (!store.indexNames.contains('institutionId')) store.createIndex('institutionId', 'institutionId', { unique: false });
            if (!store.indexNames.contains('syncStatus')) store.createIndex('syncStatus', 'syncStatus', { unique: false });
            if (name === 'offline_clinic_visits' && !store.indexNames.contains('patientId')) store.createIndex('patientId', 'patientId', { unique: false });
            if (name === 'offline_clinic_prescriptions' && !store.indexNames.contains('patientId')) store.createIndex('patientId', 'patientId', { unique: false });
            if (name === 'offline_clinic_checkins' && !store.indexNames.contains('patientId')) store.createIndex('patientId', 'patientId', { unique: false });
          });
        }
        if (oldVersion < 17) {
          ['offline_clinic_inventory', 'offline_clinic_product_scans', 'offline_clinic_dispensing', 'offline_clinic_billing', 'offline_clinic_payments', 'offline_clinic_claims'].forEach(function (name) {
            var store = db.objectStoreNames.contains(name)
              ? event.target.transaction.objectStore(name)
              : db.createObjectStore(name, { keyPath: 'localId' });
            if (!store.indexNames.contains('institutionId')) store.createIndex('institutionId', 'institutionId', { unique: false });
            if (!store.indexNames.contains('syncStatus')) store.createIndex('syncStatus', 'syncStatus', { unique: false });
            if (name === 'offline_clinic_inventory' && !store.indexNames.contains('updatedAt')) store.createIndex('updatedAt', 'updatedAt', { unique: false });
            if (name === 'offline_clinic_billing' && !store.indexNames.contains('createdAt')) store.createIndex('createdAt', 'createdAt', { unique: false });
          });
        }
        if (oldVersion < 18 && !db.objectStoreNames.contains('offline_clinic_dashboard')) {
          var clinicDashboardStore = db.createObjectStore('offline_clinic_dashboard', { keyPath: 'institutionId' });
          clinicDashboardStore.createIndex('updatedAt', 'updatedAt', { unique: false });
        }
        if (oldVersion < 19) {
          ['offline_farm_movements', 'offline_farm_attendance'].forEach(function (name) {
            var farmStore = db.objectStoreNames.contains(name)
              ? event.target.transaction.objectStore(name)
              : db.createObjectStore(name, { keyPath: 'localId' });
            if (!farmStore.indexNames.contains('farmId')) farmStore.createIndex('farmId', 'farmId', { unique: false });
            if (!farmStore.indexNames.contains('syncStatus')) farmStore.createIndex('syncStatus', 'syncStatus', { unique: false });
          });
          if (!db.objectStoreNames.contains('offline_farm_reports')) {
            var farmReportStore = db.createObjectStore('offline_farm_reports', { keyPath: 'reportKey' });
            farmReportStore.createIndex('farmId', 'farmId', { unique: false });
            farmReportStore.createIndex('summaryDate', 'summaryDate', { unique: false });
          }
        }
        if (oldVersion < 20) {
          ['offline_farm_egg_collections', 'offline_farm_feed_consumption'].forEach(function (name) {
            var farmStepTwoStore = db.objectStoreNames.contains(name)
              ? event.target.transaction.objectStore(name)
              : db.createObjectStore(name, { keyPath: 'localId' });
            if (!farmStepTwoStore.indexNames.contains('farmId')) farmStepTwoStore.createIndex('farmId', 'farmId', { unique: false });
            if (!farmStepTwoStore.indexNames.contains('syncStatus')) farmStepTwoStore.createIndex('syncStatus', 'syncStatus', { unique: false });
          });
        }
        if (oldVersion < 21 && !db.objectStoreNames.contains('offline_farm_inventory')) {
          var farmInventoryStore = db.createObjectStore('offline_farm_inventory', { keyPath: 'itemId' });
          farmInventoryStore.createIndex('farmId', 'farmId', { unique: false });
          farmInventoryStore.createIndex('updatedAt', 'updatedAt', { unique: false });
        }
        if (oldVersion < 22) {
          ['offline_mfi_loans', 'offline_mfi_loan_payments'].forEach(function (name) {
            var loanStore = db.objectStoreNames.contains(name)
              ? event.target.transaction.objectStore(name)
              : db.createObjectStore(name, { keyPath: 'localId' });
            if (!loanStore.indexNames.contains('institutionId')) loanStore.createIndex('institutionId', 'institutionId', { unique: false });
            if (!loanStore.indexNames.contains('syncStatus')) loanStore.createIndex('syncStatus', 'syncStatus', { unique: false });
          });
        }
      };
      request.onsuccess = function () {
        var db = request.result;
        db.onversionchange = function () {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };
      request.onerror = function () {
        dbPromise = null;
        reject(request.error || new Error('Unable to open offline storage'));
      };
      request.onblocked = function () {
        /* A later open can proceed once an old tab closes; keep this request alive. */
      };
    });
    return dbPromise;
  }

  function requestPromise(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error('IndexedDB request failed')); };
    });
  }

  function transaction(storeNames, mode, operation) {
    return openDatabase().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx;
        try {
          tx = db.transaction(storeNames, mode);
        } catch (error) {
          reject(error);
          return;
        }
        var result;
        var settled = false;
        tx.oncomplete = function () {
          settled = true;
          resolve(result);
        };
        tx.onerror = function () {
          if (!settled) reject(tx.error || new Error('IndexedDB transaction failed'));
        };
        tx.onabort = function () {
          if (!settled) reject(tx.error || new Error('IndexedDB transaction aborted'));
        };
        try {
          result = operation(tx);
        } catch (error) {
          try { tx.abort(); } catch (_) { /* transaction already finished */ }
          reject(error);
        }
      });
    });
  }

  function getRecord(store, key) {
    return transaction(store, 'readonly', function (tx) {
      return requestPromise(tx.objectStore(store).get(key));
    });
  }

  function putRecord(store, value) {
    return transaction(store, 'readwrite', function (tx) {
      return requestPromise(tx.objectStore(store).put(value));
    });
  }

  function deleteRecord(store, key) {
    return transaction(store, 'readwrite', function (tx) {
      return requestPromise(tx.objectStore(store).delete(key));
    });
  }

  function allRecords(store) {
    return transaction(store, 'readonly', function (tx) {
      var objectStore = tx.objectStore(store);
      if (objectStore.getAll) return requestPromise(objectStore.getAll());
      return new Promise(function (resolve, reject) {
        var values = [];
        var cursor = objectStore.openCursor();
        cursor.onsuccess = function (event) {
          var current = event.target.result;
          if (current) {
            values.push(current.value);
            current.continue();
          } else {
            resolve(values);
          }
        };
        cursor.onerror = function () { reject(cursor.error || new Error('Unable to read offline records')); };
      });
    });
  }

  function randomId(prefix) {
    if (root.crypto && root.crypto.randomUUID) return prefix + root.crypto.randomUUID();
    var bytes = new Uint8Array(12);
    if (root.crypto && root.crypto.getRandomValues) root.crypto.getRandomValues(bytes);
    else for (var i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    var result = '';
    for (var j = 0; j < bytes.length; j += 1) result += bytes[j].toString(16).padStart(2, '0');
    return prefix + Date.now().toString(36) + '-' + result;
  }

  function textBytes(value) {
    if (root.TextEncoder) return new root.TextEncoder().encode(String(value));
    var encoded = unescape(encodeURIComponent(String(value)));
    var bytes = new Uint8Array(encoded.length);
    for (var i = 0; i < encoded.length; i += 1) bytes[i] = encoded.charCodeAt(i);
    return bytes;
  }

  function bytesToBase64(bytes) {
    var value = '';
    for (var i = 0; i < bytes.length; i += 1) value += String.fromCharCode(bytes[i]);
    return root.btoa(value);
  }

  function base64ToBytes(value) {
    var binary = root.atob(value);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function hashPassword(password, salt) {
    if (!root.crypto || !root.crypto.subtle) return fail('Web Crypto is required for offline password verification');
    return root.crypto.subtle.digest('SHA-256', new Blob([salt, textBytes(password)]))
      .then(function (digest) { return new Uint8Array(digest); });
  }

  function secureHash(password, salt) {
    /* Blob is not accepted by all older subtle.digest implementations. */
    if (!root.crypto || !root.crypto.subtle) return fail('Web Crypto is required for offline password verification');
    var saltBytes = base64ToBytes(salt);
    var input = new Uint8Array(saltBytes.length + textBytes(password).length);
    input.set(saltBytes, 0);
    input.set(textBytes(password), saltBytes.length);
    return root.crypto.subtle.digest('SHA-256', input).then(function (digest) {
      return bytesToBase64(new Uint8Array(digest));
    });
  }

  function safeProfile(record) {
    if (!record) return null;
    return {
      userId: record.userId,
      role: record.role,
      schoolId: record.schoolId,
      lastSync: record.lastSync,
      email: record.email,
      name: record.name || '',
      phone: record.phone || '',
      educationLevel: record.educationLevel || '',
      address: record.address || '',
      loginCount: record.loginCount || 0
    };
  }

  function normalizeMode(mode) {
    return VALID_MODES.indexOf(mode) >= 0 ? mode : null;
  }

  function connectionInfo() {
    return root.navigator && (root.navigator.connection || root.navigator.mozConnection || root.navigator.webkitConnection);
  }

  function detectConnectionMode() {
    var nav = root.navigator || {};
    if (nav.onLine === false) return 'offline';
    var connection = connectionInfo();
    if (connection) {
      var type = String(connection.type || '').toLowerCase();
      var effective = String(connection.effectiveType || '').toLowerCase();
      if (type === 'cellular' || /(^|-)2g|(^|-)3g/.test(effective)) return 'mobile';
      if (type === 'wifi' || effective.indexOf('4g') >= 0) return 'wifi';
    }
    return null;
  }

  function getConnectionMode() {
    var live = detectConnectionMode();
    if (live) return Promise.resolve(live);
    return getRecord('offline_settings', FALLBACK_KEY).then(function (record) {
      return normalizeMode(record && record.connectionMode) || null;
    });
  }

  function emitMode(mode) {
    if (mode === lastMode) return;
    var previous = lastMode;
    lastMode = mode;
    modeListeners.slice().forEach(function (listener) {
      try { listener(mode, previous); } catch (_) { /* listeners are application-owned */ }
    });
  }

  function refreshMode() {
    return getConnectionMode().then(function (mode) {
      emitMode(mode);
      return mode;
    });
  }

  function sizeOf(value, seen) {
    if (value == null) return 0;
    if (typeof value === 'string') return textBytes(value).byteLength;
    if (typeof value === 'number' || typeof value === 'boolean') return 8;
    if (typeof Blob !== 'undefined' && value instanceof Blob) return value.size;
    if (value instanceof ArrayBuffer) return value.byteLength;
    if (ArrayBuffer.isView && ArrayBuffer.isView(value)) return value.byteLength;
    if (typeof value !== 'object') return 0;
    seen = seen || [];
    if (seen.indexOf(value) >= 0) return 0;
    seen.push(value);
    return Object.keys(value).reduce(function (total, key) { return total + sizeOf(value[key], seen); }, 0);
  }

  function compressPhoto(value, maxBytes) {
    maxBytes = maxBytes || 500 * 1024;
    if (!value || typeof value.size !== 'number' || value.size <= maxBytes) return Promise.resolve(value);
    if (!root.createImageBitmap) return fail('Photo is larger than 500KB and this browser cannot compress it offline');
    return root.createImageBitmap(value).then(function (image) {
      var width = image.width;
      var height = image.height;
      var scale = Math.min(1, Math.sqrt(maxBytes / value.size));
      width = Math.max(1, Math.round(width * scale));
      height = Math.max(1, Math.round(height * scale));
      var canvas = root.OffscreenCanvas ? new root.OffscreenCanvas(width, height) :
        (root.document && root.document.createElement ? root.document.createElement('canvas') : null);
      if (!canvas) throw new Error('Photo is larger than 500KB and no offline image canvas is available');
      canvas.width = width;
      canvas.height = height;
      var context = canvas.getContext('2d');
      context.drawImage(image, 0, 0, width, height);
      function encode(quality) {
        var output;
        if (canvas.convertToBlob) output = canvas.convertToBlob({ type: 'image/jpeg', quality: quality });
        else output = new Promise(function (resolve) { canvas.toBlob(resolve, 'image/jpeg', quality); });
        return output.then(function (blob) {
          if (!blob) throw new Error('Unable to compress project photo');
          if (blob.size <= maxBytes || quality <= 0.35) {
            if (blob.size > maxBytes) throw new Error('Project photo could not be compressed below 500KB');
            return blob;
          }
          return encode(quality - 0.1);
        });
      }
      return encode(0.85);
    });
  }

  function mergeLatest(existing, incoming) {
    if (!existing) return incoming;
    var existingTime = new Date(existing.updatedAt || existing.watchedAt || existing.createdAt || 0).getTime();
    var incomingTime = new Date(incoming.updatedAt || incoming.watchedAt || incoming.createdAt || 0).getTime();
    return incomingTime >= existingTime ? incoming : existing;
  }

  function fetchBlob(url) {
    if (typeof root.fetch !== 'function') return fail('Fetch is not available in this browser');
    return root.fetch(url, { credentials: 'same-origin' }).then(function (response) {
      if (!response.ok) throw new Error('Unable to download offline resource (' + response.status + ')');
      return response.blob();
    });
  }

  function urlObject(url) {
    try {
      return new URL(url, root.location && root.location.href ? root.location.href : 'http://localhost/');
    } catch (_) {
      return null;
    }
  }

  function isBlockedMediaHost(hostname) {
    var host = String(hostname || '').toLowerCase().replace(/\.$/, '');
    return host === 'youtube.com' || host.slice(-12) === '.youtube.com' ||
      host === 'youtu.be' || host.slice(-9) === '.youtu.be' || /(^|\.)youtube-nocookie\.com$/.test(host) ||
      host === 'googlevideo.com' || host.slice(-16) === '.googlevideo.com';
  }

  function isFirebaseStorageHost(hostname) {
    var host = String(hostname || '').toLowerCase();
    return host === 'firebasestorage.googleapis.com' ||
      host === 'storage.googleapis.com' ||
      host === 'appshule-app.firebasestorage.app';
  }

  function isCacheEligibleUrl(url) {
    var parsed = urlObject(url);
    if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) return false;
    if (isBlockedMediaHost(parsed.hostname)) return false;
    var location = root.location;
    var sameOrigin = location && parsed.origin === location.origin;
    return !!(sameOrigin || isFirebaseStorageHost(parsed.hostname));
  }

  function isSafeCustomMediaUrl(url) {
    var parsed = urlObject(url);
    return !!(parsed && (parsed.protocol === 'http:' || parsed.protocol === 'https:') && !isBlockedMediaHost(parsed.hostname));
  }

  function mobileConfirmation(options) {
    if (!options) options = {};
    if (typeof options.confirm === 'function') return !!options.confirm();
    if (options.confirm === true) return true;
    if (options.confirm === false) return false;
    if (typeof root.confirm === 'function') return root.confirm('This download uses mobile data. Continue?');
    throw new Error('MOBILE_CONFIRMATION_REQUIRED');
  }

  function currentMode() {
    return getConnectionMode();
  }

  function saveSettings(userId, settings) {
    if (!userId) return fail('userId is required for offline settings');
    return getRecord('offline_settings', userId).then(function (old) {
      var result = Object.assign({}, DEFAULT_SETTINGS, old || {}, settings || {}, { userId: userId });
      return putRecord('offline_settings', result).then(function () { return result; });
    });
  }

  function getSettings(userId) {
    if (!userId) return Promise.resolve(Object.assign({}, DEFAULT_SETTINGS));
    return getRecord('offline_settings', userId).then(function (record) {
      var settings = Object.assign({}, DEFAULT_SETTINGS, record || {}, { userId: userId });
      var currentMonth = new Date().toISOString().slice(0, 7);
      if (settings.usageMonth !== currentMonth) {
        settings.usageMonth = currentMonth;
        settings.downloadedBytes = 0;
        settings.uploadedBytes = 0;
        return putRecord('offline_settings', settings).then(function () { return settings; });
      }
      return settings;
    });
  }

  function recordDataUsage(userId, direction, bytes) {
    if (!userId || (direction !== 'downloadedBytes' && direction !== 'uploadedBytes')) return Promise.resolve(null);
    bytes = Math.max(0, Number(bytes) || 0);
    if (!bytes) return getSettings(userId);
    return getSettings(userId).then(function (settings) {
      settings[direction] = Number(settings[direction] || 0) + bytes;
      settings.usageMonth = new Date().toISOString().slice(0, 7);
      return putRecord('offline_settings', settings);
    });
  }

  var STORAGE_CONTENT_STORES = [
    'offline_videos',
    'offline_video_studio',
    'offline_pdfs',
    'offline_projects',
    'offline_ca_records',
    'offline_views',
    'offline_curriculum_links',
    'offline_favorites',
    'offline_recent_curriculum',
    'offline_ncdc_modules',
    'offline_teacher_progress'
  ];

  function isAiVideo(record) {
    var mode = String(record && (record.mode || record.videoMode || record.generationMode || '')).toLowerCase();
    return mode === 'ai_auto' || mode === 'teacher_twin' || mode === 'twin' || mode === 'ai';
  }

  function storageCategoryFor(store, record) {
    if (store === 'offline_pdfs') return 'pdfs';
    if (store === 'offline_projects') return 'projects';
    if (store === 'offline_video_studio' && isAiVideo(record)) return 'aiVideos';
    if (store === 'offline_videos' || store === 'offline_video_studio') return 'cartoonVideos';
    return 'other';
  }

  function getStorageBreakdown() {
    return Promise.all(STORAGE_CONTENT_STORES.map(function (store) {
      return allRecords(store).then(function (items) { return { store: store, items: items }; });
    })).then(function (groups) {
      var result = {
        cartoonVideos: { bytes: 0, count: 0 },
        aiVideos: { bytes: 0, count: 0 },
        pdfs: { bytes: 0, count: 0 },
        projects: { bytes: 0, count: 0 },
        other: { bytes: 0, count: 0 }
      };
      groups.forEach(function (group) {
        group.items.forEach(function (item) {
          var category = storageCategoryFor(group.store, item);
          var bytes = Number(item && item.size) || sizeOf(item);
          result[category].bytes += bytes;
          result[category].count += 1;
        });
      });
      result.totalBytes = Object.keys(result).reduce(function (sum, key) {
        return key === 'totalBytes' ? sum : sum + result[key].bytes;
      }, 0);
      result.availableBytes = 500 * 1024 * 1024;
      return result;
    });
  }

  function clearWhere(store, predicate) {
    return transaction(store, 'readwrite', function (tx) {
      var request = tx.objectStore(store).openCursor();
      request.onsuccess = function (event) {
        var cursor = event.target.result;
        if (!cursor) return;
        if (!predicate || predicate(cursor.value)) cursor.delete();
        cursor.continue();
      };
    });
  }

  function clearStorageCategory(category) {
    var jobs;
    if (category === 'all') jobs = STORAGE_CONTENT_STORES.map(function (store) { return clearWhere(store); });
    else if (category === 'cartoonVideos') jobs = [
      clearWhere('offline_videos'),
      clearWhere('offline_video_studio', function (record) { return !isAiVideo(record); })
    ];
    else if (category === 'aiVideos') jobs = [clearWhere('offline_video_studio', isAiVideo)];
    else if (category === 'pdfs') jobs = [clearWhere('offline_pdfs')];
    else if (category === 'projects') jobs = [clearWhere('offline_projects')];
    else return fail('Unknown storage category');
    return Promise.all(jobs).then(function () { return getStorageBreakdown(); });
  }

  function recordSyncHistory(userId, entry) {
    if (!userId) return Promise.resolve(null);
    var value = Object.assign({}, entry || {}, {
      historyId: randomId('sync-'),
      userId: userId,
      completedAt: new Date().toISOString()
    });
    return putRecord('offline_sync_history', value).then(function () { return value; });
  }

  function listSyncHistory(userId) {
    return allRecords('offline_sync_history').then(function (items) {
      return items.filter(function (item) { return !userId || item.userId === userId; })
        .sort(function (left, right) { return new Date(right.completedAt || 0) - new Date(left.completedAt || 0); })
        .slice(0, 10);
    });
  }

  function pendingSummary() {
    return Promise.all([
      allRecords('offline_projects'),
      allRecords('offline_ca_records'),
      allRecords('offline_views'),
      allRecords('offline_teacher_progress'),
      allRecords('offline_favorites'),
      allRecords('offline_mfi_customers'),
      allRecords('offline_mfi_collateral'),
      allRecords('offline_mfi_verification'),
      allRecords('offline_clinic_visits'),
      allRecords('offline_clinic_prescriptions'),
          allRecords('offline_clinic_checkins'),
          allRecords('offline_clinic_inventory'),
          allRecords('offline_clinic_product_scans'),
          allRecords('offline_clinic_dispensing'),
          allRecords('offline_clinic_billing'),
          allRecords('offline_clinic_payments'),
          allRecords('offline_clinic_claims'),
          allRecords('offline_farm_movements'),
          allRecords('offline_farm_attendance'),
      allRecords('offline_farm_egg_collections'),
      allRecords('offline_farm_feed_consumption'),
      allRecords('offline_farm_inventory'),
      allRecords('offline_mfi_loans'),
      allRecords('offline_mfi_loan_payments'),
      Promise.all(STORAGE_CONTENT_STORES.map(function (store) { return allRecords(store); }))
    ])
      .then(function (records) {
        var projects = records[0].filter(function (item) { return item.syncStatus === 'pending' || item.syncStatus === 'syncing'; });
        var caRecords = records[1].filter(function (item) { return item.synced === false || item.syncStatus === 'pending'; });
        var views = records[2].filter(function (item) { return item.synced === false && isCompletedView(item); });
        var teacherProgress = records[3].filter(function (item) { return item.syncStatus === 'pending'; });
        var favorites = records[4].filter(function (item) { return item.syncStatus === 'pending'; });
        var mfiCustomers = records[5].filter(function (item) { return item.syncStatus === 'pending'; });
        var mfiCollateral = records[6].filter(function (item) { return item.syncStatus === 'pending'; });
        var mfiVerification = records[7].filter(function (item) { return item.syncStatus === 'pending'; });
         var clinicVisits = records[8].filter(function (item) { return item.syncStatus === 'pending'; });
         var clinicPrescriptions = records[9].filter(function (item) { return item.syncStatus === 'pending'; });
          var clinicCheckins = records[10].filter(function (item) { return item.syncStatus === 'pending'; });
          var clinicInventory = records[11].filter(function (item) { return item.syncStatus === 'pending'; });
          var clinicScans = records[12].filter(function (item) { return item.syncStatus === 'pending'; });
          var clinicDispensing = records[13].filter(function (item) { return item.syncStatus === 'pending'; });
          var clinicBilling = records[14].filter(function (item) { return item.syncStatus === 'pending'; });
          var clinicPayments = records[15].filter(function (item) { return item.syncStatus === 'pending'; });
           var clinicClaims = records[16].filter(function (item) { return item.syncStatus === 'pending'; });
           var farmMovements = records[17].filter(function (item) { return item.syncStatus === 'pending'; });
           var farmAttendance = records[18].filter(function (item) { return item.syncStatus === 'pending'; });
            var farmEggCollections = records[19].filter(function (item) { return item.syncStatus === 'pending'; });
            var farmFeedConsumption = records[20].filter(function (item) { return item.syncStatus === 'pending'; });
            var farmInventory = records[21].filter(function (item) { return item.syncStatus === 'pending'; });
            var mfiLoans = records[22].filter(function (item) { return item.syncStatus === 'pending'; });
            var mfiLoanPayments = records[23].filter(function (item) { return item.syncStatus === 'pending'; });
            var pending = projects.concat(caRecords, views, teacherProgress, favorites, mfiCustomers, mfiCollateral, mfiVerification, clinicVisits, clinicPrescriptions, clinicCheckins, clinicInventory, clinicScans, clinicDispensing, clinicBilling, clinicPayments, clinicClaims, farmMovements, farmAttendance, farmEggCollections, farmFeedConsumption, mfiLoans, mfiLoanPayments);
            var cachedSize = records[24].reduce(function (total, items) {
          return total + items.reduce(function (sum, item) { return sum + Number(item.size || sizeOf(item)); }, 0);
        }, 0);
        return {
          projects: projects.length,
          caRecords: caRecords.length,
          views: views.length,
          teacherProgress: teacherProgress.length,
          favorites: favorites.length,
          mfiCustomers: mfiCustomers.length,
          mfiCollateral: mfiCollateral.length,
          mfiVerification: mfiVerification.length,
          clinicVisits: clinicVisits.length,
          clinicPrescriptions: clinicPrescriptions.length,
          clinicCheckins: clinicCheckins.length,
          clinicInventory: clinicInventory.length,
          clinicScans: clinicScans.length,
          clinicDispensing: clinicDispensing.length,
          clinicBilling: clinicBilling.length,
          clinicPayments: clinicPayments.length,
          clinicClaims: clinicClaims.length,
           farmMovements: farmMovements.length,
           farmAttendance: farmAttendance.length,
            farmEggCollections: farmEggCollections.length,
            farmFeedConsumption: farmFeedConsumption.length,
          farmInventory: farmInventory.length,
          mfiLoans: mfiLoans.length,
          mfiLoanPayments: mfiLoanPayments.length,
          total: pending.length,
          size: pending.reduce(function (sum, item) { return sum + Number(item.size || sizeOf(item)); }, 0),
          cachedSize: cachedSize
        };
      });
  }

  function sync(options) {
    options = options || {};
    return currentMode().then(function (mode) {
      return Promise.all([
        allRecords('offline_projects'),
        allRecords('offline_ca_records'),
        allRecords('offline_views'),
        allRecords('offline_mfi_customers'),
        allRecords('offline_mfi_collateral'),
         allRecords('offline_mfi_verification'),
         allRecords('offline_clinic_visits'),
         allRecords('offline_clinic_prescriptions'),
          allRecords('offline_clinic_checkins'),
          allRecords('offline_clinic_inventory'),
          allRecords('offline_clinic_product_scans'),
          allRecords('offline_clinic_dispensing'),
          allRecords('offline_clinic_billing'),
          allRecords('offline_clinic_payments'),
           allRecords('offline_clinic_claims'),
           allRecords('offline_farm_movements'),
           allRecords('offline_farm_attendance'),
           allRecords('offline_farm_egg_collections'),
           allRecords('offline_farm_feed_consumption'),
           allRecords('offline_mfi_loans'),
           allRecords('offline_mfi_loan_payments')
      ]).then(function (records) {
        var projects = records[0].filter(function (item) { return item.syncStatus === 'pending' || item.syncStatus === 'syncing'; });
        var caRecords = records[1].filter(function (item) { return item.synced === false || item.syncStatus === 'pending'; });
        var views = records[2].filter(function (item) { return item.synced === false && isCompletedView(item); });
        var mfiCustomers = records[3].filter(function (item) { return item.syncStatus === 'pending'; });
        var mfiCollateral = records[4].filter(function (item) { return item.syncStatus === 'pending'; });
        var mfiVerification = records[5].filter(function (item) { return item.syncStatus === 'pending'; });
         var clinicVisits = records[6].filter(function (item) { return item.syncStatus === 'pending'; });
         var clinicPrescriptions = records[7].filter(function (item) { return item.syncStatus === 'pending'; });
          var clinicCheckins = records[8].filter(function (item) { return item.syncStatus === 'pending'; });
          var clinicInventory = records[9].filter(function (item) { return item.syncStatus === 'pending'; });
          var clinicScans = records[10].filter(function (item) { return item.syncStatus === 'pending'; });
          var clinicDispensing = records[11].filter(function (item) { return item.syncStatus === 'pending'; });
          var clinicBilling = records[12].filter(function (item) { return item.syncStatus === 'pending'; });
          var clinicPayments = records[13].filter(function (item) { return item.syncStatus === 'pending'; });
           var clinicClaims = records[14].filter(function (item) { return item.syncStatus === 'pending'; });
           var farmMovements = records[15].filter(function (item) { return item.syncStatus === 'pending'; });
           var farmAttendance = records[16].filter(function (item) { return item.syncStatus === 'pending'; });
            var farmEggCollections = records[17].filter(function (item) { return item.syncStatus === 'pending'; });
            var farmFeedConsumption = records[18].filter(function (item) { return item.syncStatus === 'pending'; });
            var mfiLoans = records[19].filter(function (item) { return item.syncStatus === 'pending'; });
            var mfiLoanPayments = records[20].filter(function (item) { return item.syncStatus === 'pending'; });
            var total = projects.length + caRecords.length + views.length + mfiCustomers.length + mfiCollateral.length + mfiVerification.length + clinicVisits.length + clinicPrescriptions.length + clinicCheckins.length + clinicInventory.length + clinicScans.length + clinicDispensing.length + clinicBilling.length + clinicPayments.length + clinicClaims.length + farmMovements.length + farmAttendance.length + farmEggCollections.length + farmFeedConsumption.length + mfiLoans.length + mfiLoanPayments.length;
        if (mode === 'offline') return { status: 'offline', mode: mode, uploaded: 0, pending: total };
        if (mode === 'mobile' && !options.force && options.auto && !options.allowMobile) {
          return { status: 'mobile-paused', mode: mode, uploaded: 0, pending: total };
        }
        var context = { mode: mode, api: API };
        /* Every push completes before any pull begins. */
           var pushed = { projects: false, caRecords: false, views: false, mfiCustomers: false, mfiCollateral: false, mfiVerification: false, clinicVisits: false, clinicPrescriptions: false, clinicCheckins: false, clinicInventory: false, clinicScans: false, clinicDispensing: false, clinicBilling: false, clinicPayments: false, clinicClaims: false, farmMovements: false, farmAttendance: false, farmEggCollections: false, farmFeedConsumption: false, mfiLoans: false, mfiLoanPayments: false };
        return Promise.resolve()
          .then(function () {
            if (!syncHooks.pushProjects || !projects.length) return null;
            return syncHooks.pushProjects(projects, context);
          })
          .then(function (result) { if (syncHooks.pushProjects && projects.length) pushed.projects = true; return result; })
          .then(function () {
            if (!syncHooks.pushCARecords || !caRecords.length) return null;
            return syncHooks.pushCARecords(caRecords, context);
          })
          .then(function (result) { if (syncHooks.pushCARecords && caRecords.length) pushed.caRecords = true; return result; })
          .then(function () {
            if (!syncHooks.pushViews || !views.length) return null;
            return syncHooks.pushViews(views, context);
          })
          .then(function (result) { if (syncHooks.pushViews && views.length) pushed.views = true; return result; })
          .then(function () {
            if (!syncHooks.pushMfiCustomers || !mfiCustomers.length) return null;
            return syncHooks.pushMfiCustomers(mfiCustomers, context);
          })
          .then(function (result) { if (syncHooks.pushMfiCustomers && mfiCustomers.length) pushed.mfiCustomers = true; return result; })
          .then(function () {
            if (!syncHooks.pushMfiCollateral || !mfiCollateral.length) return null;
            return syncHooks.pushMfiCollateral(mfiCollateral, context);
          })
          .then(function (result) { if (syncHooks.pushMfiCollateral && mfiCollateral.length) pushed.mfiCollateral = true; return result; })
          .then(function () {
            if (!syncHooks.pushMfiVerification || !mfiVerification.length) return null;
            return syncHooks.pushMfiVerification(mfiVerification, context);
          })
          .then(function (result) { if (syncHooks.pushMfiVerification && mfiVerification.length) pushed.mfiVerification = true; return result; })
           .then(function () {
             if (!syncHooks.pushClinicVisits || !clinicVisits.length) return null;
             return syncHooks.pushClinicVisits(clinicVisits, context);
           })
           .then(function (result) { if (syncHooks.pushClinicVisits && clinicVisits.length) pushed.clinicVisits = true; return result; })
           .then(function () {
             if (!syncHooks.pushClinicPrescriptions || !clinicPrescriptions.length) return null;
             return syncHooks.pushClinicPrescriptions(clinicPrescriptions, context);
           })
           .then(function (result) { if (syncHooks.pushClinicPrescriptions && clinicPrescriptions.length) pushed.clinicPrescriptions = true; return result; })
           .then(function () {
             if (!syncHooks.pushClinicCheckins || !clinicCheckins.length) return null;
             return syncHooks.pushClinicCheckins(clinicCheckins, context);
           })
           .then(function (result) { if (syncHooks.pushClinicCheckins && clinicCheckins.length) pushed.clinicCheckins = true; return result; })
            .then(function () {
              if (!syncHooks.pushClinicInventory || !clinicInventory.length) return null;
              return syncHooks.pushClinicInventory(clinicInventory, context);
            })
            .then(function (result) { if (syncHooks.pushClinicInventory && clinicInventory.length) pushed.clinicInventory = true; return result; })
            .then(function () {
              if (!syncHooks.pushClinicScans || !clinicScans.length) return null;
              return syncHooks.pushClinicScans(clinicScans, context);
            })
            .then(function (result) { if (syncHooks.pushClinicScans && clinicScans.length) pushed.clinicScans = true; return result; })
            .then(function () {
              if (!syncHooks.pushClinicDispensing || !clinicDispensing.length) return null;
              return syncHooks.pushClinicDispensing(clinicDispensing, context);
            })
            .then(function (result) { if (syncHooks.pushClinicDispensing && clinicDispensing.length) pushed.clinicDispensing = true; return result; })
            .then(function () {
              if (!syncHooks.pushClinicBilling || !clinicBilling.length) return null;
              return syncHooks.pushClinicBilling(clinicBilling, context);
            })
            .then(function (result) { if (syncHooks.pushClinicBilling && clinicBilling.length) pushed.clinicBilling = true; return result; })
            .then(function () {
              if (!syncHooks.pushClinicPayments || !clinicPayments.length) return null;
              return syncHooks.pushClinicPayments(clinicPayments, context);
            })
            .then(function (result) { if (syncHooks.pushClinicPayments && clinicPayments.length) pushed.clinicPayments = true; return result; })
            .then(function () {
              if (!syncHooks.pushClinicClaims || !clinicClaims.length) return null;
              return syncHooks.pushClinicClaims(clinicClaims, context);
            })
            .then(function (result) { if (syncHooks.pushClinicClaims && clinicClaims.length) pushed.clinicClaims = true; return result; })
           .then(function () {
             if (!syncHooks.pushFarmMovements || !farmMovements.length) return null;
             return syncHooks.pushFarmMovements(farmMovements, context);
           })
           .then(function (result) { if (syncHooks.pushFarmMovements && farmMovements.length) pushed.farmMovements = true; return result; })
           .then(function () {
             if (!syncHooks.pushFarmAttendance || !farmAttendance.length) return null;
             return syncHooks.pushFarmAttendance(farmAttendance, context);
           })
           .then(function (result) { if (syncHooks.pushFarmAttendance && farmAttendance.length) pushed.farmAttendance = true; return result; })
            .then(function () {
              if (!syncHooks.pushFarmEggCollections || !farmEggCollections.length) return null;
              return syncHooks.pushFarmEggCollections(farmEggCollections, context);
            })
            .then(function (result) { if (syncHooks.pushFarmEggCollections && farmEggCollections.length) pushed.farmEggCollections = true; return result; })
            .then(function () {
              if (!syncHooks.pushFarmFeedConsumption || !farmFeedConsumption.length) return null;
              return syncHooks.pushFarmFeedConsumption(farmFeedConsumption, context);
            })
            .then(function (result) { if (syncHooks.pushFarmFeedConsumption && farmFeedConsumption.length) pushed.farmFeedConsumption = true; return result; })
            .then(function () {
              if (!syncHooks.pushMfiLoans || !mfiLoans.length) return null;
              return syncHooks.pushMfiLoans(mfiLoans, context);
            })
            .then(function (result) { if (syncHooks.pushMfiLoans && mfiLoans.length) pushed.mfiLoans = true; return result; })
            .then(function () {
              if (!syncHooks.pushMfiLoanPayments || !mfiLoanPayments.length) return null;
              return syncHooks.pushMfiLoanPayments(mfiLoanPayments, context);
            })
            .then(function (result) { if (syncHooks.pushMfiLoanPayments && mfiLoanPayments.length) pushed.mfiLoanPayments = true; return result; })
          .then(function () {
            return Promise.all((pushed.projects ? projects.map(function (item) { return putRecord('offline_projects', Object.assign({}, item, { syncStatus: 'synced', syncedAt: Date.now() })); }) : [])
              .concat(pushed.caRecords ? caRecords.map(function (item) { return putRecord('offline_ca_records', Object.assign({}, item, { synced: true, syncStatus: 'synced', syncedAt: Date.now() })); }) : [])
              .concat(pushed.views ? views.map(function (item) { return putRecord('offline_views', Object.assign({}, item, { synced: true, syncedAt: Date.now() })); }) : [])
              .concat(pushed.mfiCustomers ? mfiCustomers.map(function (item) { return putRecord('offline_mfi_customers', Object.assign({}, item, { syncStatus: 'synced', syncedAt: Date.now() })); }) : [])
              .concat(pushed.mfiCollateral ? mfiCollateral.map(function (item) { return putRecord('offline_mfi_collateral', Object.assign({}, item, { syncStatus: 'synced', syncedAt: Date.now() })); }) : [])
               .concat(pushed.mfiVerification ? mfiVerification.map(function (item) { return putRecord('offline_mfi_verification', Object.assign({}, item, { syncStatus: 'synced', syncedAt: Date.now() })); }) : [])
               .concat(pushed.clinicVisits ? clinicVisits.map(function (item) { return putRecord('offline_clinic_visits', Object.assign({}, item, { syncStatus: 'synced', syncedAt: Date.now() })); }) : [])
               .concat(pushed.clinicPrescriptions ? clinicPrescriptions.map(function (item) { return putRecord('offline_clinic_prescriptions', Object.assign({}, item, { syncStatus: 'synced', syncedAt: Date.now() })); }) : [])
               .concat(pushed.clinicCheckins ? clinicCheckins.map(function (item) { return putRecord('offline_clinic_checkins', Object.assign({}, item, { syncStatus: 'synced', syncedAt: Date.now() })); }) : [])
               .concat(pushed.clinicInventory ? clinicInventory.map(function (item) { return putRecord('offline_clinic_inventory', Object.assign({}, item, { syncStatus: 'synced', syncedAt: Date.now() })); }) : [])
               .concat(pushed.clinicScans ? clinicScans.map(function (item) { return putRecord('offline_clinic_product_scans', Object.assign({}, item, { syncStatus: 'synced', syncedAt: Date.now() })); }) : [])
               .concat(pushed.clinicDispensing ? clinicDispensing.map(function (item) { return putRecord('offline_clinic_dispensing', Object.assign({}, item, { syncStatus: 'synced', syncedAt: Date.now() })); }) : [])
               .concat(pushed.clinicBilling ? clinicBilling.map(function (item) { return putRecord('offline_clinic_billing', Object.assign({}, item, { syncStatus: 'synced', syncedAt: Date.now() })); }) : [])
                .concat(pushed.clinicPayments ? clinicPayments.map(function (item) { return putRecord('offline_clinic_payments', Object.assign({}, item, { syncStatus: 'synced', syncedAt: Date.now() })); }) : [])
                .concat(pushed.clinicClaims ? clinicClaims.map(function (item) { return putRecord('offline_clinic_claims', Object.assign({}, item, { syncStatus: 'synced', syncedAt: Date.now() })); }) : [])
                .concat(pushed.farmMovements ? farmMovements.map(function (item) { return putRecord('offline_farm_movements', Object.assign({}, item, { syncStatus: 'synced', syncedAt: Date.now() })); }) : [])
                 .concat(pushed.farmAttendance ? farmAttendance.map(function (item) { return putRecord('offline_farm_attendance', Object.assign({}, item, { syncStatus: 'synced', syncedAt: Date.now() })); }) : [])
                 .concat(pushed.farmEggCollections ? farmEggCollections.map(function (item) { return putRecord('offline_farm_egg_collections', Object.assign({}, item, { syncStatus: 'synced', syncedAt: Date.now() })); }) : [])
                 .concat(pushed.farmFeedConsumption ? farmFeedConsumption.map(function (item) { return putRecord('offline_farm_feed_consumption', Object.assign({}, item, { syncStatus: 'synced', syncedAt: Date.now() })); }) : [])
                 .concat(pushed.mfiLoans ? mfiLoans.map(function (item) { return putRecord('offline_mfi_loans', Object.assign({}, item, { syncStatus: 'synced', syncedAt: Date.now() })); }) : [])
                 .concat(pushed.mfiLoanPayments ? mfiLoanPayments.map(function (item) { return putRecord('offline_mfi_loan_payments', Object.assign({}, item, { syncStatus: 'synced', syncedAt: Date.now() })); }) : []));
          })
          .then(function () {
            var pullResult = syncHooks.pull ? syncHooks.pull(context) : {};
            return Promise.resolve(pullResult).then(function (pulled) {
              pulled = pulled || {};
              var individualPulls = [
                syncHooks.pullProjects ? syncHooks.pullProjects(context) : null,
                syncHooks.pullCARecords ? syncHooks.pullCARecords(context) : null,
                 syncHooks.pullViews ? syncHooks.pullViews(context) : null,
                 syncHooks.pullCurriculumLinks ? syncHooks.pullCurriculumLinks(context) : null
              ];
              return Promise.all(individualPulls).then(function (individual) {
                pulled = Object.assign({}, pulled, {
                  projects: pulled.projects || individual[0] || [],
                  caRecords: pulled.caRecords || individual[1] || [],
                  views: pulled.views || individual[2] || [],
                  curriculumLinks: pulled.curriculumLinks || individual[3] || []
                });
                return pulled;
              });
            }).then(function (pulled) {
              if (!pulled) return null;
              return Promise.all([
                (pulled.projects || []).reduce(function (p, item) {
                  return p.then(function () { return getRecord('offline_projects', item.localId).then(function (old) { return putRecord('offline_projects', mergeLatest(old, item)); }); });
                }, Promise.resolve()),
                (pulled.caRecords || []).reduce(function (p, item) {
                  return p.then(function () { return getRecord('offline_ca_records', item.recordId).then(function (old) { return putRecord('offline_ca_records', mergeLatest(old, item)); }); });
                }, Promise.resolve()),
                (pulled.views || []).reduce(function (p, item) {
                  return p.then(function () { return getRecord('offline_views', item.viewId).then(function (old) { return putRecord('offline_views', mergeLatest(old, item)); }); });
                 }, Promise.resolve()),
                 (pulled.curriculumLinks || []).reduce(function (p, item) {
                   return p.then(function () { return getRecord('offline_curriculum_links', item.docId).then(function (old) { return putRecord('offline_curriculum_links', mergeLatest(old, item)); }); });
                }, Promise.resolve())
              ]);
            });
          })
          .then(function () {
             var uploaded = (pushed.projects ? projects.length : 0) + (pushed.caRecords ? caRecords.length : 0) + (pushed.views ? views.length : 0) + (pushed.mfiCustomers ? mfiCustomers.length : 0) + (pushed.mfiCollateral ? mfiCollateral.length : 0) + (pushed.mfiVerification ? mfiVerification.length : 0) + (pushed.clinicVisits ? clinicVisits.length : 0) + (pushed.clinicPrescriptions ? clinicPrescriptions.length : 0) + (pushed.clinicCheckins ? clinicCheckins.length : 0) + (pushed.clinicInventory ? clinicInventory.length : 0) + (pushed.clinicScans ? clinicScans.length : 0) + (pushed.clinicDispensing ? clinicDispensing.length : 0) + (pushed.clinicBilling ? clinicBilling.length : 0) + (pushed.clinicPayments ? clinicPayments.length : 0) + (pushed.clinicClaims ? clinicClaims.length : 0) + (pushed.farmMovements ? farmMovements.length : 0) + (pushed.farmAttendance ? farmAttendance.length : 0);
            return pendingSummary().then(function (remaining) {
              return { status: 'complete', mode: mode, uploaded: uploaded, pending: remaining.total };
            });
          });
      });
    });
  }

  var API = {
    databaseName: DB_NAME,
    stores: STORE_NAMES.slice(),
    open: openDatabase,
    migrateOfflineViews: function () { return openDatabase(); },
    detectConnectionMode: detectConnectionMode,
    getConnectionMode: getConnectionMode,
    resolveConnectionMode: getConnectionMode,
    onConnectionChange: function (listener) {
      if (typeof listener !== 'function') return function () {};
      modeListeners.push(listener);
      return function () { modeListeners = modeListeners.filter(function (item) { return item !== listener; }); };
    },
    setConnectionPreference: function (mode) {
      if (!normalizeMode(mode)) return fail('Connection preference must be offline, mobile, or wifi');
      return putRecord('offline_settings', { userId: FALLBACK_KEY, connectionMode: mode }).then(function () { emitMode(mode); return mode; });
    },
    needsConnectionPreference: function () { return !detectConnectionMode(); },
    connectionLabel: function (mode) {
      return { offline: 'Offline Mode - Working, will sync at school', mobile: 'Mobile data - Data saver mode', wifi: 'WiFi connected - Full HD mode' }[mode] || '';
    },
    saveAuthProfile: function (profile, password) {
      if (!profile || !profile.userId || typeof password !== 'string' || !password) return fail('userId and password are required to cache an offline profile');
      if (!root.crypto || !root.crypto.getRandomValues) return fail('Secure random number generation is required');
      var saltBytes = new Uint8Array(16);
      root.crypto.getRandomValues(saltBytes);
      var salt = bytesToBase64(saltBytes);
      return secureHash(password, salt).then(function (verifier) {
        var record = {
          userId: String(profile.userId),
          role: profile.role || null,
          schoolId: profile.schoolId || null,
          email: profile.email || null,
          name: profile.name || '',
          phone: profile.phone || '',
          educationLevel: profile.educationLevel || '',
          address: profile.address || '',
          loginCount: profile.loginCount || 0,
          lastSync: Date.now(),
          passwordSalt: salt,
          passwordVerifier: verifier
        };
        return putRecord('offline_auth', record).then(function () { return safeProfile(record); });
      });
    },
    cacheOnlineProfile: function (profile, password) {
      return API.saveAuthProfile(profile, password);
    },
    verifyOfflineLogin: function (userId, password) {
      return getRecord('offline_auth', userId).then(function (record) {
        if (!record || !record.passwordSalt || !record.passwordVerifier || typeof password !== 'string') return false;
        return secureHash(password, record.passwordSalt).then(function (candidate) {
          var left = base64ToBytes(candidate);
          var right = base64ToBytes(record.passwordVerifier);
          if (left.length !== right.length) return false;
          var difference = 0;
          for (var i = 0; i < left.length; i += 1) difference |= left[i] ^ right[i];
          return difference === 0;
        });
      });
    },
    getCachedAuthProfile: function (userId) { return getRecord('offline_auth', userId).then(safeProfile); },
    findCachedAuthProfile: function (email) {
      email = String(email || '').trim().toLowerCase();
      return allRecords('offline_auth').then(function (records) {
        var record = records.find(function (item) { return String(item.email || '').trim().toLowerCase() === email; });
        return safeProfile(record);
      });
    },
    verifyOfflineLoginByEmail: function (email, password) {
      email = String(email || '').trim().toLowerCase();
      return allRecords('offline_auth').then(function (records) {
        var record = records.find(function (item) { return String(item.email || '').trim().toLowerCase() === email; });
        if (!record) return null;
        return API.verifyOfflineLogin(record.userId, password).then(function (valid) { return valid ? safeProfile(record) : null; });
      });
    },
    saveSettings: saveSettings,
    getSettings: getSettings,
    recordDataUsage: recordDataUsage,
    getStorageBreakdown: getStorageBreakdown,
    clearStorageCategory: clearStorageCategory,
    recordSyncHistory: recordSyncHistory,
    listSyncHistory: listSyncHistory,
    cacheInstitutionBranding: function (branding) {
      if (!branding || !branding.institutionId) return fail('institutionId is required for branding cache');
      return putRecord('offline_branding', Object.assign({}, branding, { cachedAt: Date.now() }));
    },
    getInstitutionBranding: function (institutionId) {
      return institutionId ? getRecord('offline_branding', institutionId) : Promise.resolve(null);
    },
    clearInstitutionBranding: function (institutionId) {
      return institutionId ? deleteRecord('offline_branding', institutionId) : transaction('offline_branding', 'readwrite', function (tx) { tx.objectStore('offline_branding').clear(); });
    },
    cacheCommandStats: function (stats) {
      return putRecord('offline_command_stats', Object.assign({}, stats || {}, { statsKey: 'superadmin', cachedAt: Date.now() }));
    },
    getCommandStats: function () {
      return getRecord('offline_command_stats', 'superadmin');
    },
    getPendingSummary: pendingSummary,
    getPendingCounts: function () { return pendingSummary().then(function (summary) { return { projects: summary.projects, caRecords: summary.caRecords, views: summary.views, mfiCustomers: summary.mfiCustomers, mfiCollateral: summary.mfiCollateral, mfiVerification: summary.mfiVerification, clinicVisits: summary.clinicVisits, clinicPrescriptions: summary.clinicPrescriptions, clinicCheckins: summary.clinicCheckins, total: summary.total }; }); },
    getPendingSize: function () { return pendingSummary().then(function (summary) { return summary.size; }); },
    getStorageSummary: pendingSummary,
    queueProject: function (project) {
      project = project || {};
      var photoKey = project.photoBlob ? 'photoBlob' : (project.photo && typeof project.photo.size === 'number' ? 'photo' : null);
      return (photoKey ? compressPhoto(project[photoKey]) : Promise.resolve(null)).then(function (photo) {
        var value = Object.assign({}, project, {
          localId: project.localId || randomId('project-'),
          syncStatus: project.syncStatus || 'pending',
          queuedAt: project.queuedAt || Date.now()
        });
        if (photoKey && photo) value[photoKey] = photo;
        value.size = project.size || sizeOf(value);
        return putRecord('offline_projects', value).then(function () { return value; });
      });
    },
    cacheProject: function (project) {
      project = project || {};
      if (!project.id) return fail('A server project id is required for caching');
      var value = Object.assign({}, project, {
        localId: project.localId || 'cache-project-' + project.id,
        payload: project,
        cacheOnly: true,
        syncStatus: 'synced',
        cachedAt: Date.now(),
        size: sizeOf(project)
      });
      return putRecord('offline_projects', value).then(function () { return value; });
    },
    compressProjectPhoto: compressPhoto,
    queueCARecord: function (record) {
      if (!record) return fail('A CA record is required');
      var value = Object.assign({}, record, { recordId: record.recordId || randomId('ca-'), synced: false, syncStatus: 'pending' });
      return putRecord('offline_ca_records', value).then(function () { return value; });
    },
    queueView: function (view) {
      view = Object.assign({}, view || {}, { queuedAt: (view && view.queuedAt) || Date.now() });
      var value = Object.assign({}, normalizeOfflineView(view), { synced: false });
      return putRecord('offline_views', value).then(function () { return value; });
    },
    listProjects: function () { return allRecords('offline_projects'); },
    cacheCurriculumLinks: function (links) {
      links = Array.isArray(links) ? links : [];
      if (links.length > 2000) return fail('Curriculum cache is limited to 2000 records');
      return transaction('offline_curriculum_links', 'readwrite', function (tx) {
        var store = tx.objectStore('offline_curriculum_links');
        store.clear();
        links.forEach(function (link) {
          if (!link) return;
          var value = Object.assign({}, link, {
            docId: String(link.docId || link.id || ''),
            lastSyncedAt: Date.now()
          });
          if (value.docId) store.put(value);
        });
        return links.length;
      }).then(function () { return links; });
    },
    listCurriculumLinks: function () { return allRecords('offline_curriculum_links'); },
    queueFavorite: function (favorite) {
      favorite = favorite || {};
      if (!favorite.userId || !favorite.curriculumDocId) return fail('A user and curriculum document are required for favorites');
      var value = Object.assign({}, favorite, {
        favoriteKey: String(favorite.userId) + '|' + String(favorite.curriculumDocId),
        saved: favorite.saved !== false,
        syncStatus: 'pending',
        savedAt: favorite.savedAt || new Date().toISOString()
      });
      return putRecord('offline_favorites', value).then(function () { return value; });
    },
    listFavorites: function (userId) {
      return allRecords('offline_favorites').then(function (items) {
        return items.filter(function (item) { return !userId || item.userId === userId; });
      });
    },
    markFavoriteSynced: function (favoriteKey) {
      return getRecord('offline_favorites', favoriteKey).then(function (item) {
        return item ? putRecord('offline_favorites', Object.assign({}, item, { syncStatus: 'synced', syncedAt: Date.now() })) : false;
      });
    },
    recordRecentCurriculum: function (record) {
      record = record || {};
      if (!record.docId) return fail('A curriculum document id is required');
      return putRecord('offline_recent_curriculum', Object.assign({}, record, { viewedAt: record.viewedAt || Date.now() }));
    },
    listRecentCurriculum: function () {
      return allRecords('offline_recent_curriculum').then(function (items) {
        return items.sort(function (left, right) { return Number(right.viewedAt || 0) - Number(left.viewedAt || 0); }).slice(0, 5);
      });
    },
    cacheNcdcModules: function (modules) {
      modules = Array.isArray(modules) ? modules : [];
      return transaction('offline_ncdc_modules', 'readwrite', function (tx) {
        var store = tx.objectStore('offline_ncdc_modules');
        store.clear();
        modules.forEach(function (module) {
          if (!module || !module.moduleNumber) return;
          store.put(Object.assign({}, module, { moduleNumber: Number(module.moduleNumber), cachedAt: Date.now() }));
        });
        return modules.length;
      }).then(function () { return modules; });
    },
    listNcdcModules: function () { return allRecords('offline_ncdc_modules'); },
    queueTeacherProgress: function (progress) {
      progress = progress || {};
      if (!progress.teacherId || !progress.moduleNumber) return fail('A teacher and module number are required');
      var value = Object.assign({}, progress, {
        teacherId: String(progress.teacherId),
        moduleNumber: Number(progress.moduleNumber),
        progressKey: String(progress.teacherId) + '_' + String(progress.moduleNumber),
        syncStatus: 'pending',
        queuedAt: progress.queuedAt || Date.now()
      });
      return putRecord('offline_teacher_progress', value).then(function () { return value; });
    },
    listTeacherProgress: function (teacherId) {
      return allRecords('offline_teacher_progress').then(function (items) {
        return items.filter(function (item) { return !teacherId || item.teacherId === teacherId; });
      });
    },
    cacheVideoStudio: function (video) {
      video = video || {};
      if (!video.libraryId) return fail('A published libraryId is required');
      var record = Object.assign({}, video, {
        libraryId: String(video.libraryId),
        cached: true,
        cachedAt: Date.now(),
        versionType: 'cartoon-slideshow',
        size: sizeOf(video.slideshowImages || video.images || []) +
          sizeOf(video.captions || video.captionsText || '') +
          sizeOf(video.audioMetadata || {})
      });
      return putRecord('offline_video_studio', record).then(function () { return record; });
    },
    cachePdf: function (pdf, options) {
      pdf = pdf || {};
      options = options || {};
      if (!pdf.pdfId || !pdf.url) return fail('A PDF id and URL are required');
      if (!isCacheEligibleUrl(pdf.url)) return fail('This PDF URL is not eligible for offline caching');
      return fetchBlob(pdf.url).then(function (blob) {
        var record = Object.assign({}, pdf, {
          pdfId: String(pdf.pdfId),
          pdfBlob: blob,
          cached: true,
          cachedAt: Date.now(),
          size: blob.size
        });
        return putRecord('offline_pdfs', record).then(function () {
          return recordDataUsage(options.userId, 'downloadedBytes', record.size).then(function () { return record; });
        });
      });
    },
    getCachedPdf: function (pdfId) {
      return getRecord('offline_pdfs', String(pdfId));
    },
    getVideoStudio: function (libraryId) {
      return getRecord('offline_video_studio', String(libraryId));
    },
    listVideoStudio: function () {
      return allRecords('offline_video_studio');
    },
    deleteVideoStudio: function (libraryId) {
      return deleteRecord('offline_video_studio', String(libraryId));
    },
    markTeacherProgressSynced: function (progressKey) {
      return getRecord('offline_teacher_progress', progressKey).then(function (item) {
        return item ? putRecord('offline_teacher_progress', Object.assign({}, item, { syncStatus: 'synced', syncedAt: Date.now() })) : false;
      });
    },
    queueMfiCustomer: function (customer) {
      customer = customer || {};
      if (!customer.firstName || !customer.lastName || !customer.phone) return fail('A customer name and phone are required');
      var value = Object.assign({}, customer, {
        localId: customer.localId || randomId('mfi-customer-'),
        syncStatus: customer.syncStatus || 'pending',
        queuedAt: customer.queuedAt || Date.now()
      });
      return putRecord('offline_mfi_customers', value).then(function () { return value; });
    },
    listMfiCustomers: function (institutionId) {
      return allRecords('offline_mfi_customers').then(function (items) {
        return items.filter(function (item) { return !institutionId || item.institutionId === institutionId; });
      });
    },
    markMfiCustomerSynced: function (localId, extra) {
      return getRecord('offline_mfi_customers', localId).then(function (item) {
        return item ? putRecord('offline_mfi_customers', Object.assign({}, item, extra || {}, { syncStatus: 'synced', syncedAt: Date.now() })) : false;
      });
    },
    queueMfiCollateral: function (collateral) {
      collateral = collateral || {};
      if (!collateral.customerId || !collateral.typeId || !collateral.description) return fail('A customer, collateral type, and description are required');
      var value = Object.assign({}, collateral, {
        localId: collateral.localId || randomId('mfi-collateral-'),
        syncStatus: collateral.syncStatus || 'pending',
        queuedAt: collateral.queuedAt || Date.now(),
        status: collateral.status || 'draft'
      });
      return putRecord('offline_mfi_collateral', value).then(function () { return value; });
    },
    listMfiCollateral: function (institutionId) {
      return allRecords('offline_mfi_collateral').then(function (items) {
        return items.filter(function (item) { return !institutionId || item.institutionId === institutionId; });
      });
    },
    markMfiCollateralSynced: function (localId, extra) {
      return getRecord('offline_mfi_collateral', localId).then(function (item) {
        return item ? putRecord('offline_mfi_collateral', Object.assign({}, item, extra || {}, { syncStatus: 'synced', syncedAt: Date.now() })) : false;
      });
    },
    queueMfiVerification: function (verification) {
      verification = verification || {};
      if (!verification.verificationId || !verification.collateralId || !verification.notes) return fail('A verification, collateral, and completion note are required');
      var value = Object.assign({}, verification, {
        localId: verification.localId || randomId('mfi-verification-'),
        syncStatus: 'pending',
        queuedAt: verification.queuedAt || Date.now(),
        status: 'completed'
      });
      return putRecord('offline_mfi_verification', value).then(function () { return value; });
    },
    listMfiVerification: function (institutionId) {
      return allRecords('offline_mfi_verification').then(function (items) {
        return items.filter(function (item) { return !institutionId || item.institutionId === institutionId; });
      });
    },
    markMfiVerificationSynced: function (localId, extra) {
      return getRecord('offline_mfi_verification', localId).then(function (item) {
        return item ? putRecord('offline_mfi_verification', Object.assign({}, item, extra || {}, { syncStatus: 'synced', syncedAt: Date.now() })) : false;
      });
    },
    queueMfiLoan: function (loan) {
      loan = loan || {};
      if (!loan.institutionId || !loan.customerId || !loan.productId) return fail('An institution, customer, and loan product are required');
      var value = Object.assign({}, loan, { localId: loan.localId || randomId('mfi-loan-'), syncStatus: loan.syncStatus || 'pending', queuedAt: loan.queuedAt || Date.now() });
      return putRecord('offline_mfi_loans', value).then(function () { return value; });
    },
    listMfiLoans: function (institutionId) {
      return allRecords('offline_mfi_loans').then(function (items) {
        return items.filter(function (item) { return !institutionId || item.institutionId === institutionId; });
      });
    },
    markMfiLoanSynced: function (localId, extra) {
      return getRecord('offline_mfi_loans', localId).then(function (item) {
        return item ? putRecord('offline_mfi_loans', Object.assign({}, item, extra || {}, { syncStatus: 'synced', syncedAt: Date.now() })) : false;
      });
    },
    queueMfiLoanPayment: function (payment) {
      payment = payment || {};
      if (!payment.institutionId || !payment.loanId || !payment.amount) return fail('An institution, loan, and positive payment are required');
      var value = Object.assign({}, payment, { localId: payment.localId || randomId('mfi-loan-payment-'), syncStatus: 'pending', queuedAt: payment.queuedAt || Date.now() });
      return putRecord('offline_mfi_loan_payments', value).then(function () { return value; });
    },
    listMfiLoanPayments: function (institutionId) {
      return allRecords('offline_mfi_loan_payments').then(function (items) {
        return items.filter(function (item) { return !institutionId || item.institutionId === institutionId; });
      });
    },
    markMfiLoanPaymentSynced: function (localId, extra) {
      return getRecord('offline_mfi_loan_payments', localId).then(function (item) {
        return item ? putRecord('offline_mfi_loan_payments', Object.assign({}, item, extra || {}, { syncStatus: 'synced', syncedAt: Date.now() })) : false;
      });
    },
    queueFarmMovement: function (movement) {
      movement = movement || {};
      if (!movement.farmId || !movement.direction || !movement.animalTypeId) return fail('A farm, animal type, and direction are required');
      var direction = String(movement.direction).toUpperCase();
      if (direction !== 'IN' && direction !== 'OUT') return fail('Movement direction must be IN or OUT');
      var value = Object.assign({}, movement, {
        localId: movement.localId || randomId('farm-movement-'),
        direction: direction,
        confidenceScore: Math.max(0, Math.min(100, Number(movement.confidenceScore == null ? 0 : movement.confidenceScore))),
        syncStatus: movement.syncStatus || 'pending',
        queuedAt: movement.queuedAt || Date.now(),
        detectedAt: movement.detectedAt || new Date().toISOString()
      });
      return putRecord('offline_farm_movements', value).then(function () { return value; });
    },
    listFarmMovements: function (farmId) {
      return allRecords('offline_farm_movements').then(function (items) {
        return items.filter(function (item) { return !farmId || item.farmId === farmId; })
          .sort(function (left, right) { return new Date(right.detectedAt || 0) - new Date(left.detectedAt || 0); });
      });
    },
    markFarmMovementSynced: function (localId, extra) {
      return getRecord('offline_farm_movements', localId).then(function (item) {
        return item ? putRecord('offline_farm_movements', Object.assign({}, item, extra || {}, { syncStatus: 'synced', syncedAt: Date.now() })) : false;
      });
    },
    queueFarmAttendance: function (attendance) {
      attendance = attendance || {};
      if (!attendance.farmId || !attendance.workerId || !attendance.attendanceDate) return fail('A farm, worker, and attendance date are required');
      var value = Object.assign({}, attendance, {
        localId: attendance.localId || randomId('farm-attendance-'),
        syncStatus: attendance.syncStatus || 'pending',
        queuedAt: attendance.queuedAt || Date.now(),
        recordedAt: attendance.recordedAt || new Date().toISOString()
      });
      return putRecord('offline_farm_attendance', value).then(function () { return value; });
    },
    listFarmAttendance: function (farmId, attendanceDate) {
      return allRecords('offline_farm_attendance').then(function (items) {
        return items.filter(function (item) { return (!farmId || item.farmId === farmId) && (!attendanceDate || item.attendanceDate === attendanceDate); });
      });
    },
    markFarmAttendanceSynced: function (localId, extra) {
      return getRecord('offline_farm_attendance', localId).then(function (item) {
        return item ? putRecord('offline_farm_attendance', Object.assign({}, item, extra || {}, { syncStatus: 'synced', syncedAt: Date.now() })) : false;
      });
    },
    queueFarmEggCollection: function (collection) {
      collection = collection || {};
      if (!collection.farmId || !collection.collectedBy || !collection.collectedAt) return fail('A farm, collector, and collection time are required');
      var trays = Math.max(0, Number(collection.traysCollected || 0));
      var eggsPerTray = Math.max(1, Number(collection.eggsPerTray || 30));
      var totalEggs = trays * eggsPerTray;
      var brokenEggs = Math.min(totalEggs, Math.max(0, Number(collection.brokenEggs || 0)));
      var value = Object.assign({}, collection, {
        localId: collection.localId || randomId('farm-egg-'),
        traysCollected: trays,
        eggsPerTray: eggsPerTray,
        totalEggs: totalEggs,
        brokenEggs: brokenEggs,
        goodEggs: Math.max(0, totalEggs - brokenEggs),
        syncStatus: collection.syncStatus || 'pending',
        queuedAt: collection.queuedAt || Date.now()
      });
      return putRecord('offline_farm_egg_collections', value).then(function () { return value; });
    },
    listFarmEggCollections: function (farmId, date) {
      return allRecords('offline_farm_egg_collections').then(function (items) {
        return items.filter(function (item) {
          return (!farmId || item.farmId === farmId) && (!date || String(item.collectedAt || '').slice(0, 10) === date);
        }).sort(function (left, right) {
          return new Date(right.collectedAt || 0) - new Date(left.collectedAt || 0);
        });
      });
    },
    markFarmEggCollectionSynced: function (localId, extra) {
      return getRecord('offline_farm_egg_collections', localId).then(function (item) {
        return item ? putRecord('offline_farm_egg_collections', Object.assign({}, item, extra || {}, { syncStatus: 'synced', syncedAt: Date.now() })) : false;
      });
    },
    queueFarmFeedConsumption: function (consumption) {
      consumption = consumption || {};
      if (!consumption.farmId || !consumption.itemId || !consumption.quantityConsumed) return fail('A farm, feed item, and quantity are required');
      var value = Object.assign({}, consumption, {
        localId: consumption.localId || randomId('farm-feed-'),
        quantityConsumed: Math.max(0, Number(consumption.quantityConsumed || 0)),
        syncStatus: consumption.syncStatus || 'pending',
        queuedAt: consumption.queuedAt || Date.now()
      });
      return putRecord('offline_farm_feed_consumption', value).then(function () { return value; });
    },
    listFarmFeedConsumption: function (farmId, date) {
      return allRecords('offline_farm_feed_consumption').then(function (items) {
        return items.filter(function (item) {
          return (!farmId || item.farmId === farmId) && (!date || String(item.fedAt || '').slice(0, 10) === date);
        }).sort(function (left, right) {
          return new Date(right.fedAt || 0) - new Date(left.fedAt || 0);
        });
      });
    },
    markFarmFeedConsumptionSynced: function (localId, extra) {
      return getRecord('offline_farm_feed_consumption', localId).then(function (item) {
        return item ? putRecord('offline_farm_feed_consumption', Object.assign({}, item, extra || {}, { syncStatus: 'synced', syncedAt: Date.now() })) : false;
      });
    },
    cacheFarmInventory: function (item) {
      item = item || {};
      if (!item.itemId && !item.id) return fail('An inventory item id is required');
      return putRecord('offline_farm_inventory', Object.assign({}, item, {
        itemId: item.itemId || item.id,
        cachedAt: Date.now()
      }));
    },
    listFarmInventory: function (farmId) {
      return allRecords('offline_farm_inventory').then(function (items) {
        return items.filter(function (item) { return !farmId || item.farmId === farmId; });
      });
    },
    cacheFarmReport: function (report) {
      report = report || {};
      if (!report.farmId || !report.summaryDate) return fail('A farm and summary date are required for report caching');
      return putRecord('offline_farm_reports', Object.assign({}, report, {
        reportKey: String(report.farmId) + '|' + String(report.summaryDate),
        cachedAt: Date.now()
      }));
    },
    getFarmReport: function (farmId, summaryDate) {
      return farmId && summaryDate ? getRecord('offline_farm_reports', String(farmId) + '|' + String(summaryDate)) : Promise.resolve(null);
    },
    listFarmReports: function (farmId) {
      return allRecords('offline_farm_reports').then(function (items) {
        return items.filter(function (item) { return !farmId || item.farmId === farmId; })
          .sort(function (left, right) { return String(right.summaryDate || '').localeCompare(String(left.summaryDate || '')); });
      });
    },
    queueClinicVisit: function (visit) {
      visit = visit || {};
      if (!visit.institutionId || !visit.patientId || !visit.visitDate) return fail('An institution, patient, and visit date are required');
      var value = Object.assign({}, visit, {
        localId: visit.localId || randomId('clinic-visit-'),
        syncStatus: visit.syncStatus || 'pending',
        queuedAt: visit.queuedAt || Date.now()
      });
      return putRecord('offline_clinic_visits', value).then(function () { return value; });
    },
    listClinicVisits: function (institutionId, patientId) {
      return allRecords('offline_clinic_visits').then(function (items) {
        return items.filter(function (item) { return (!institutionId || item.institutionId === institutionId) && (!patientId || item.patientId === patientId); });
      });
    },
    markClinicVisitSynced: function (localId, extra) {
      return getRecord('offline_clinic_visits', localId).then(function (item) {
        return item ? putRecord('offline_clinic_visits', Object.assign({}, item, extra || {}, { syncStatus: 'synced', syncedAt: Date.now() })) : false;
      });
    },
    queueClinicPrescription: function (prescription) {
      prescription = prescription || {};
      if (!prescription.institutionId || !prescription.patientId || !prescription.visitId) return fail('An institution, patient, and visit are required');
      var value = Object.assign({}, prescription, {
        localId: prescription.localId || randomId('clinic-prescription-'),
        syncStatus: prescription.syncStatus || 'pending',
        queuedAt: prescription.queuedAt || Date.now()
      });
      return putRecord('offline_clinic_prescriptions', value).then(function () { return value; });
    },
    listClinicPrescriptions: function (institutionId, patientId) {
      return allRecords('offline_clinic_prescriptions').then(function (items) {
        return items.filter(function (item) { return (!institutionId || item.institutionId === institutionId) && (!patientId || item.patientId === patientId); });
      });
    },
    markClinicPrescriptionSynced: function (localId, extra) {
      return getRecord('offline_clinic_prescriptions', localId).then(function (item) {
        return item ? putRecord('offline_clinic_prescriptions', Object.assign({}, item, extra || {}, { syncStatus: 'synced', syncedAt: Date.now() })) : false;
      });
    },
    queueClinicCheckin: function (checkin) {
      checkin = checkin || {};
      if (!checkin.institutionId || !checkin.patientId || !checkin.appointmentId) return fail('An institution, patient, and appointment are required');
      var value = Object.assign({}, checkin, {
        localId: checkin.localId || randomId('clinic-checkin-'),
        syncStatus: checkin.syncStatus || 'pending',
        queuedAt: checkin.queuedAt || Date.now(),
        checkedInAt: checkin.checkedInAt || new Date().toISOString()
      });
      return putRecord('offline_clinic_checkins', value).then(function () { return value; });
    },
    listClinicCheckins: function (institutionId, patientId) {
      return allRecords('offline_clinic_checkins').then(function (items) {
        return items.filter(function (item) { return (!institutionId || item.institutionId === institutionId) && (!patientId || item.patientId === patientId); });
      });
    },
    markClinicCheckinSynced: function (localId, extra) {
      return getRecord('offline_clinic_checkins', localId).then(function (item) {
        return item ? putRecord('offline_clinic_checkins', Object.assign({}, item, extra || {}, { syncStatus: 'synced', syncedAt: Date.now() })) : false;
      });
    },
    queueClinicInventory: function (item) {
      item = item || {};
      if (!item.institutionId || !item.itemName) return fail('An institution and item name are required');
      var value = Object.assign({}, item, {
        localId: item.localId || randomId('clinic-inventory-'),
        syncStatus: item.syncStatus || 'pending',
        queuedAt: item.queuedAt || Date.now()
      });
      return putRecord('offline_clinic_inventory', value).then(function () { return value; });
    },
    listClinicInventory: function (institutionId) {
      return allRecords('offline_clinic_inventory').then(function (items) {
        return items.filter(function (item) { return !institutionId || item.institutionId === institutionId; });
      });
    },
    markClinicInventorySynced: function (localId, extra) {
      return getRecord('offline_clinic_inventory', localId).then(function (item) {
        return item ? putRecord('offline_clinic_inventory', Object.assign({}, item, extra || {}, { syncStatus: 'synced', syncedAt: Date.now() })) : false;
      });
    },
    queueClinicProductScan: function (scan) {
      scan = scan || {};
      if (!scan.institutionId || !scan.scannedBy) return fail('An institution and scanner user are required');
      var value = Object.assign({}, scan, {
        localId: scan.localId || randomId('clinic-scan-'),
        syncStatus: scan.syncStatus || 'pending',
        queuedAt: scan.queuedAt || Date.now()
      });
      return putRecord('offline_clinic_product_scans', value).then(function () { return value; });
    },
    listClinicProductScans: function (institutionId) {
      return allRecords('offline_clinic_product_scans').then(function (items) {
        return items.filter(function (item) { return !institutionId || item.institutionId === institutionId; });
      });
    },
    queueClinicDispensing: function (dispensing) {
      dispensing = dispensing || {};
      if (!dispensing.institutionId || !dispensing.itemId || !dispensing.quantity) return fail('An institution, item, and quantity are required');
      var value = Object.assign({}, dispensing, {
        localId: dispensing.localId || randomId('clinic-dispensing-'),
        syncStatus: dispensing.syncStatus || 'pending',
        queuedAt: dispensing.queuedAt || Date.now()
      });
      return putRecord('offline_clinic_dispensing', value).then(function () { return value; });
    },
    queueClinicBilling: function (bill) {
      bill = bill || {};
      if (!bill.institutionId || !bill.totalAmount) return fail('An institution and bill total are required');
      var value = Object.assign({}, bill, {
        localId: bill.localId || randomId('clinic-bill-'),
        syncStatus: bill.syncStatus || 'pending',
        queuedAt: bill.queuedAt || Date.now()
      });
      return putRecord('offline_clinic_billing', value).then(function () { return value; });
    },
    queueClinicPayment: function (payment) {
      payment = payment || {};
      if (!payment.institutionId || !payment.billId || !payment.amount) return fail('An institution, bill, and payment amount are required');
      var value = Object.assign({}, payment, {
        localId: payment.localId || randomId('clinic-payment-'),
        syncStatus: payment.syncStatus || 'pending',
        queuedAt: payment.queuedAt || Date.now()
      });
      return putRecord('offline_clinic_payments', value).then(function () { return value; });
    },
    queueClinicClaim: function (claim) {
      claim = claim || {};
      if (!claim.institutionId || !claim.patientId || !claim.billId) return fail('An institution, patient, and bill are required');
      var value = Object.assign({}, claim, {
        localId: claim.localId || randomId('clinic-claim-'),
        syncStatus: claim.syncStatus || 'pending',
        queuedAt: claim.queuedAt || Date.now()
      });
      return putRecord('offline_clinic_claims', value).then(function () { return value; });
    },
    listClinicBilling: function (institutionId) {
      return allRecords('offline_clinic_billing').then(function (items) {
        return items.filter(function (item) { return !institutionId || item.institutionId === institutionId; }).map(function (item) {
          return Object.assign({}, item, { id: item.id || item.localId });
        });
      });
    },
    listClinicPayments: function (institutionId) {
      return allRecords('offline_clinic_payments').then(function (items) {
        return items.filter(function (item) { return !institutionId || item.institutionId === institutionId; }).map(function (item) {
          return Object.assign({}, item, { id: item.id || item.localId });
        });
      });
    },
    listClinicClaims: function (institutionId) {
      return allRecords('offline_clinic_claims').then(function (items) {
        return items.filter(function (item) { return !institutionId || item.institutionId === institutionId; }).map(function (item) {
          return Object.assign({}, item, { id: item.id || item.localId });
        });
      });
    },
    cacheClinicDashboard: function (dashboard) {
      dashboard = dashboard || {};
      if (!dashboard.institutionId) return fail('An institution is required for clinic dashboard caching');
      return putRecord('offline_clinic_dashboard', Object.assign({}, dashboard, {
        updatedAt: dashboard.updatedAt || new Date().toISOString()
      }));
    },
    getClinicDashboard: function (institutionId) {
      return getRecord('offline_clinic_dashboard', institutionId);
    },
    cacheMfiPortfolio: function (portfolio) {
      portfolio = portfolio || {};
      if (!portfolio.institutionId) return fail('An institution is required for portfolio caching');
      return putRecord('offline_mfi_portfolio', Object.assign({}, portfolio, { updatedAt: portfolio.updatedAt || new Date().toISOString() }));
    },
    getMfiPortfolio: function (institutionId) {
      return getRecord('offline_mfi_portfolio', institutionId);
    },
    listMfiPortfolio: function (institutionId) {
      return getRecord('offline_mfi_portfolio', institutionId);
    },
    cacheMfiReport: function (report) {
      report = report || {};
      if (!report.institutionId || !report.report) return fail('An institution and report are required');
      return putRecord('offline_mfi_reports', Object.assign({}, report, { localId: report.localId || randomId('mfi-report-'), cachedAt: Date.now() }));
    },
    listMfiReports: function (institutionId) {
      return allRecords('offline_mfi_reports').then(function (items) {
        return items.filter(function (item) { return !institutionId || item.institutionId === institutionId; }).sort(function (a, b) { return Number(b.cachedAt || 0) - Number(a.cachedAt || 0); });
      });
    },
    listCARecords: function () { return allRecords('offline_ca_records'); },
    listViews: function () { return allRecords('offline_views'); },
    markViewSynced: function (viewId, extra) {
      return getRecord('offline_views', viewId).then(function (item) {
        return item ? putRecord('offline_views', Object.assign({}, item, extra || {}, { synced: true, syncedAt: Date.now() })) : false;
      });
    },
    markProjectSynced: function (localId, extra) { return getRecord('offline_projects', localId).then(function (item) { return item ? putRecord('offline_projects', Object.assign({}, item, extra || {}, { syncStatus: 'synced', syncedAt: Date.now() })) : false; }); },
    recordVideoView: function (view) { return API.queueView(view); },
    isCacheEligibleUrl: isCacheEligibleUrl,
    isSafeCustomMediaUrl: isSafeCustomMediaUrl,
    downloadLightVideo: function (video, options) {
      video = video || {};
      options = options || {};
      return currentMode().then(function (mode) {
        if (mode === 'offline') throw new Error('Connect to WiFi or mobile data before downloading an offline lesson');
        if (mode === 'mobile' && !mobileConfirmation(options)) throw new Error('MOBILE_DOWNLOAD_CANCELLED');
        var images = video.slideshowImages || [];
        return Promise.all(images.map(function (item) {
          var url = typeof item === 'string' ? item : item && item.url;
          if (item && item.blob) return Promise.resolve(item.blob);
          if (!url || !isCacheEligibleUrl(url)) throw new Error('Offline light media must be same-origin or Firebase Storage; YouTube media is never cached');
          return fetchBlob(url);
        })).then(function (imageBlobs) {
          var audioUrl = video.slideshowAudioUrl;
          var audioPromise = video.slideshowAudioBlob ? Promise.resolve(video.slideshowAudioBlob) :
            (audioUrl ? (isCacheEligibleUrl(audioUrl) ? fetchBlob(audioUrl) : fail('Offline audio URL is not cache-eligible')) : Promise.resolve(null));
          return audioPromise.then(function (audioBlob) {
            var record = Object.assign({}, video, {
              videoId: video.videoId,
              slideshowImageBlobs: imageBlobs,
              slideshowAudioBlob: audioBlob,
              cached: true,
              versionType: 'slideshow',
              size: imageBlobs.reduce(function (sum, blob) { return sum + sizeOf(blob); }, 0) + sizeOf(audioBlob) + sizeOf(video.captionsText)
            });
            if (record.size > 2 * 1024 * 1024) throw new Error('The light offline lesson is larger than the 2MB limit');
            return putRecord('offline_videos', record).then(function () {
              return recordDataUsage(options.userId, 'downloadedBytes', record.size).then(function () { return record; });
            });
          });
        });
      });
    },
    downloadCustomMp4: function (video, options) {
      video = video || {};
      options = options || {};
      if (!video.videoId || !video.customMp4Url || !isSafeCustomMediaUrl(video.customMp4Url)) return fail('A non-YouTube customMp4Url is required; YouTube and Googlevideo media cannot be cached');
      return getSettings(options.userId).then(function (settings) {
        return currentMode().then(function (mode) {
          if (mode === 'offline') throw new Error('Connect before downloading an HD lesson');
          if (mode === 'mobile' && settings.downloadHdWifiOnly !== false) throw new Error('HD offline downloads are blocked on mobile data by your WiFi-only preference');
          if (mode === 'mobile' && !mobileConfirmation(options)) throw new Error('MOBILE_DOWNLOAD_CANCELLED');
          return fetchBlob(video.customMp4Url).then(function (blob) {
            var record = Object.assign({}, video, { customMp4Blob: blob, cached: true, versionType: 'custom-mp4', size: blob.size });
            return putRecord('offline_videos', record).then(function () {
              return recordDataUsage(options.userId, 'downloadedBytes', record.size).then(function () { return record; });
            });
          });
        });
      });
    },
    getOfflineVideo: function (videoId) { return getRecord('offline_videos', videoId); },
    deleteOfflineVideo: function (videoId) { return deleteRecord('offline_videos', videoId); },
    cacheNcdcTemplate: function (templateId, template, userId) {
      if (!templateId || !template) return fail('templateId and template are required');
      return putRecord('offline_settings', { userId: TEMPLATE_PREFIX + templateId, template: template, cachedAt: Date.now(), ownerUserId: userId || null }).then(function () { return template; });
    },
    getNcdcTemplate: function (templateId) {
      return getRecord('offline_settings', TEMPLATE_PREFIX + templateId).then(function (record) { return record && record.template || null; });
    },
    cacheTemplate: function (templateId, template, userId) {
      return API.cacheNcdcTemplate(templateId, template, userId);
    },
    setSyncHooks: function (hooks) { syncHooks = Object.assign({}, hooks || {}); return syncHooks; },
    configureSync: function (hooks) { syncHooks = Object.assign({}, hooks || {}); return syncHooks; },
    sync: sync,
    syncNow: function (options) {
      options = options || {};
      return currentMode().then(function (mode) {
        if (mode === 'mobile' && !options.force && !mobileConfirmation(options)) throw new Error('MOBILE_SYNC_CANCELLED');
        if (mode === 'offline') return pendingSummary().then(function (summary) { return { status: 'offline', mode: mode, uploaded: 0, pending: summary.total }; });
        return sync(Object.assign({}, options, { force: true }));
      });
    },
    getVideoPlayback: function (videoId) {
      return getRecord('offline_videos', videoId).then(function (record) {
        if (!record || !record.cached) return { available: false, message: 'Video not available offline. Download the offline version at school WiFi.' };
        if (record.versionType === 'custom-mp4' && record.customMp4Blob) return { available: true, type: 'custom-mp4', blob: record.customMp4Blob, record: record };
        if (record.versionType === 'slideshow' && record.slideshowImageBlobs) return { available: true, type: 'slideshow', images: record.slideshowImageBlobs, audio: record.slideshowAudioBlob || null, captions: record.captionsText || '', record: record };
        return { available: false, message: 'Video not available offline. Download the offline version at school WiFi.' };
      });
    }
  };

  if (root.addEventListener) {
    root.addEventListener('online', refreshMode);
    root.addEventListener('offline', refreshMode);
    var connection = connectionInfo();
    if (connection && connection.addEventListener) connection.addEventListener('change', refreshMode);
  }
  root.AppShuleOffline = API;
}(typeof window !== 'undefined' ? window : globalThis));