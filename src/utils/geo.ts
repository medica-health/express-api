import { z } from "zod";

export const latitude = z.coerce.number().min(-90).max(90);
export const longitude = z.coerce.number().min(-180).max(180);

// SQL fragment building a geography point. Always pass lng before lat (PostGIS is x,y).
export const POINT_SQL = (lngParam: string, latParam: string) =>
  `ST_SetSRID(ST_MakePoint(${lngParam}, ${latParam}), 4326)::geography`;

// Select a geography column as plain { lat, lng } numbers.
export const LAT_LNG_SQL = (col: string) =>
  `ST_Y(${col}::geometry) AS lat, ST_X(${col}::geometry) AS lng`;
