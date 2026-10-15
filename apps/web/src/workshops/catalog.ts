import { mysqlWorkshopCatalog } from "@egghead/workshop-catalog/mysql";
import { createLocalMysqlConnection, getEggheadRuntime } from "../db/local-docker";

export function createWorkshopMysqlConnection() {
  if (getEggheadRuntime() === "production") {
    throw new Error("Production workshop reads require an approved read flip");
  }
  return createLocalMysqlConnection();
}

export const workshopCatalogLayer = mysqlWorkshopCatalog(createWorkshopMysqlConnection);
