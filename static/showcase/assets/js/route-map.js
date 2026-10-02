import { projectData } from "./project-data.js";

let mapInstance;
export function activateRouteMap() {
  if (mapInstance || !window.L) return mapInstance;
  const el=document.getElementById("route-map"), data=projectData.route;
  mapInstance=L.map(el,{scrollWheelZoom:false,zoomControl:true,attributionControl:true}).setView([-25.085,27.25],9);
  const tiles=L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png",{
    maxZoom:19,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>'
  }).addTo(mapInstance);
  const latlngs=data.sites.map(s=>s.coords);
  const route=L.polyline(latlngs,{color:"#d5b66f",weight:4,opacity:.9,dashArray:"8 8"}).addTo(mapInstance);
  data.sites.forEach((s,i)=>{
    const marker=L.circleMarker(s.coords,{radius:i===1?7:8,color:s.color,weight:2,fillColor:s.color,fillOpacity:.95}).addTo(mapInstance);
    const segmentLabel = i===0
      ? `${data.segments[0].name} · ${data.segments[0].km} km`
      : i===1
        ? `中间汇集站 · ${data.segments[0].km} km + ${data.segments[1].km} km`
        : `${data.segments[1].name} · ${data.segments[1].km} km`;
    marker.bindPopup(`<strong>${s.name}</strong><br>${segmentLabel}`);
  });
  mapInstance.fitBounds(route.getBounds().pad(.18));
  let loaded=false;tiles.on("tileload",()=>{loaded=true;document.getElementById("map-fallback").hidden=true;});
  setTimeout(()=>{if(!loaded)document.getElementById("map-fallback").hidden=false;},6500);
  tiles.on("tileerror",()=>setTimeout(()=>{if(!loaded)document.getElementById("map-fallback").hidden=false;},6500));
  setTimeout(()=>mapInstance.invalidateSize(),80);
  return mapInstance;
}
