export const projectData = {
  site: {
    title: "Baphalane Solar + Battery Storage",
    center: [-25.181028, 27.393806],
    source: "场区中心坐标来自 2026-07-22 项目认知底稿，待最新测量与 KMZ 复核。",
    pv: { ac: "110 MWac", dc: "142.7 MWp", modules: "226,520", inverters: "367", transformers: "12 × 9 MVA + 1 × 6 MVA" },
    bess: { energy: "431 MWh", power: "100 MW" },
    lineKm: { baphalaneManama: 17, manamaSpitskop: 8 },
    stationCoords: {
      baphalane: [-25.187955, 27.376544],
      manama: [-25.049803, 27.255855],
      spitskop: [-24.997733, 27.125949]
    }
  },
  equipment: {
    pv: {
      title: "光伏阵列",
      detail: "按总平面图分区表现的单轴跟踪组件阵列。图纸标注 110 MWac / 142.7 MWp；组件与设备数量按图纸表达，待正式设计核定。"
    },
    inverter: {
      title: "组串式逆变器与箱变",
      detail: "逆变器布置在光伏子阵边缘，箱式升压变压器将子阵交流电送入 33 kV 集电系统。设备外形为通用展示模型。"
    },
    bess: {
      title: "电池储能区",
      detail: "图纸表达 100 MW / 431 MWh 储能系统。立体场景以电池舱、PCS 和升压单元展示主要设备关系，不按未冻结的厂家数量建模。"
    },
    ipp: {
      title: "Baphalane IPP 升压站",
      detail: "场景展示两台主变、33 kV 开关区、132 kV 构架与控制建筑的主要空间关系。具体设备配置应以正式批准图纸为准。"
    },
    om: {
      title: "运维与辅助设施",
      detail: "依据运维区总平面图表现运维楼、综合泵房、警卫室、危废库、场内道路和进场道路。"
    }
  },
  route: {
    sites: [
      { id: "baphalane", label: "Baphalane IPP", name: "Baphalane IPP Substation", coords: [-25.187955, 27.376544], color: "#e47c32" },
      { id: "manama", label: "Manama", name: "Manama Collector Station", coords: [-25.049803, 27.255855], color: "#738a86" },
      { id: "spitskop", label: "Spitskop MTS", name: "Spitskop Main Transmission Station", coords: [-24.997733, 27.125949], color: "#d1a044" }
    ],
    segments: [
      { id: "baphalane-manama", name: "Baphalane IPP — Manama", km: 17 },
      { id: "manama-spitskop", name: "Manama — Spitskop MTS", km: 8 }
    ],
    routeNote: "站点相对方位和候选路径参考项目集群 KMZ；线路仅作非比例展示，塔位为符号化表达。里程按当前参数工作基线17km+8km，待业主/Eskom书面确认。"
  }
};
