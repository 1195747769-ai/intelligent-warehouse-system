import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core';
import sheetsCoreEnUS from '@univerjs/preset-sheets-core/locales/en-US';
import sheetsCoreZhCN from '@univerjs/preset-sheets-core/locales/zh-CN';
import { createUniver, LocaleType, mergeLocales } from '@univerjs/presets';
import '@univerjs/preset-sheets-core/lib/index.css';
import './univer-preview.css';

const instances = new Map();
const columns = [
  ['source_row', '源行'], ['code', '物资编码'], ['name', '物资名称'], ['spec', '规格型号'],
  ['unit', '单位'], ['qty', '数量'], ['batch', '批次'], ['box', '箱号'],
  ['warehouse', '仓库'], ['bin', '库位'], ['package', '标段'], ['state', '库存状态'], ['attribute', '属性 / 备注'],
];

function createSheetData(rows, language) {
  const cellData = {};
  const headings = language === 'zh-CN' ? columns.map(([, title]) => title) : [
    'Source row', 'Item code', 'Item name', 'Specification', 'Unit', 'Quantity', 'Batch',
    'Box no.', 'Warehouse', 'Bin', 'Segment', 'Stock status', 'Attribute / Notes',
  ];
  cellData[0] = {};
  headings.forEach((value, col) => { cellData[0][col] = { v: value }; });
  rows.forEach((row, index) => {
    const values = columns.map(([key]) => key === 'source_row' ? row.source_row : row[key]);
    cellData[index + 1] = {};
    values.forEach((value, col) => {
      cellData[index + 1][col] = { v: value === null || value === undefined ? '' : String(value) };
    });
  });
  return {
    id: 'recognized-rows',
    name: language === 'zh-CN' ? '识别明细' : 'Recognized rows',
    rowCount: Math.max(rows.length + 1, 2),
    columnCount: columns.length,
    defaultColumnWidth: 140,
    defaultRowHeight: 26,
    columnData: { 0: { w: 76 }, 2: { w: 220 }, 3: { w: 190 }, 12: { w: 300 } },
    cellData,
  };
}

function createWorkbookData(rows, language) {
  const sheet = createSheetData(rows, language);
  return {
    id: `recognition-${crypto.randomUUID()}`,
    name: language === 'zh-CN' ? '识别结果' : 'Recognition result',
    sheetOrder: [sheet.id],
    sheets: { [sheet.id]: sheet },
  };
}

async function mount(containerId, rows, language = 'zh-CN') {
  dispose(containerId);
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('No recognition rows to display');
  const host = document.getElementById(containerId);
  if (!host) throw new Error(`Missing preview container: ${containerId}`);
  host.replaceChildren();
  host.style.visibility = 'hidden';

  const locale = language === 'zh-CN' ? LocaleType.ZH_CN : LocaleType.EN_US;
  const localMessages = language === 'zh-CN' ? sheetsCoreZhCN : sheetsCoreEnUS;
  const { univer, univerAPI } = createUniver({
    locale,
    locales: { [locale]: mergeLocales(localMessages) },
    presets: [UniverSheetsCorePreset({
      container: containerId,
      header: false,
      toolbar: true,
      formulaBar: false,
      contextMenu: false,
      footer: false,
    })],
  });
  instances.set(containerId, univer);
  try {
    const workbook = univerAPI.createWorkbook(createWorkbookData(rows, language));
    const workbookPermission = workbook.getWorkbookPermission();
    const deniedPoints = [
      univerAPI.Enum.WorkbookPermissionPoint.CreateSheet,
      univerAPI.Enum.WorkbookPermissionPoint.DeleteSheet,
      univerAPI.Enum.WorkbookPermissionPoint.RenameSheet,
      univerAPI.Enum.WorkbookPermissionPoint.MoveSheet,
      univerAPI.Enum.WorkbookPermissionPoint.Export,
      univerAPI.Enum.WorkbookPermissionPoint.CopyContent,
      univerAPI.Enum.WorkbookPermissionPoint.DuplicateFile,
      univerAPI.Enum.WorkbookPermissionPoint.InsertRow,
      univerAPI.Enum.WorkbookPermissionPoint.InsertColumn,
      univerAPI.Enum.WorkbookPermissionPoint.DeleteRow,
      univerAPI.Enum.WorkbookPermissionPoint.DeleteColumn,
    ];
    for (const point of deniedPoints) await workbookPermission.setPoint(point, false);
    const sheetPermission = workbook.getActiveSheet().getWorksheetPermission();
    await sheetPermission.setMode('filterOnly');
    univerAPI.setPermissionDialogVisible(false);
    host.style.visibility = '';
    return true;
  } catch (error) {
    dispose(containerId);
    throw error;
  }
}

function dispose(containerId) {
  const univer = instances.get(containerId);
  if (univer) {
    univer.dispose();
    instances.delete(containerId);
  }
  const host = document.getElementById(containerId);
  if (host) {
    host.replaceChildren();
    host.style.visibility = '';
  }
}

window.mountUniverPreview = mount;
window.disposeUniverPreview = dispose;
