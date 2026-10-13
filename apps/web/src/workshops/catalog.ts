import { mysqlWorkshopCatalog } from "@egghead/workshop-catalog/mysql";
import { createLocalMysqlConnection } from "../db/local-docker";

export const workshopCatalogLayer = mysqlWorkshopCatalog(createLocalMysqlConnection);
