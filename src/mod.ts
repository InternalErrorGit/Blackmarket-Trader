import {IPreAkiLoadMod} from "@spt-aki/models/external/IPreAkiLoadMod";
import {IPostDBLoadMod} from "@spt-aki/models/external/IPostDBLoadMod";
import {DependencyContainer, InjectionToken} from "tsyringe";
import {TradeController} from "@spt-aki/controllers/TradeController";
import {IPmcData} from "@spt-aki/models/eft/common/IPmcData";
import {IProcessBaseTradeRequestData} from "@spt-aki/models/eft/trade/IProcessBaseTradeRequestData";
import {Upd} from "@spt-aki/models/eft/common/tables/IItem";
import {ConfigServer} from "@spt-aki/servers/ConfigServer";
import {ITraderConfig, UpdateTime} from "@spt-aki/models/spt/config/ITraderConfig";
import {ConfigTypes} from "@spt-aki/models/enums/ConfigTypes";
import {PreAkiModLoader} from "@spt-aki/loaders/PreAkiModLoader";
import {ImageRouter} from "@spt-aki/routers/ImageRouter";
import * as base from "../database/base.json";
import {TradeHelper} from "@spt-aki/helpers/TradeHelper";
import {IItemEventRouterResponse} from "@spt-aki/models/eft/itemEvent/IItemEventRouterResponse";
import {IProcessBuyTradeRequestData} from "@spt-aki/models/eft/trade/IProcessBuyTradeRequestData";
import {IProcessSellTradeRequestData} from "@spt-aki/models/eft/trade/IProcessSellTradeRequestData";
import {ILogger} from "@spt-aki/models/spt/utils/ILogger";
import {DatabaseServer} from "@spt-aki/servers/DatabaseServer";
import {RagfairPriceService} from "@spt-aki/services/RagfairPriceService";
import {LogTextColor} from "@spt-aki/models/spt/logging/LogTextColor";
import fs from "fs";
import {JsonUtil} from "@spt-aki/utils/JsonUtil";
import {ITraderBase} from "@spt-aki/models/eft/common/tables/ITrader";
import {ILocaleGlobalBase} from "@spt-aki/models/spt/server/ILocaleBase";
import {createCSVPriceFile, disableFIRCondition, disableFleaBlacklist, showDebugLog} from "../config/config.json";
import {PaymentService} from "@spt-aki/services/PaymentService";
import {InventoryController} from "@spt-aki/controllers/InventoryController";
import {EventOutputHolder} from "@spt-aki/routers/EventOutputHolder";
import {author, name, version} from "../package.json";

class BlackmarketTrader implements IPreAkiLoadMod, IPostDBLoadMod {
  private container: DependencyContainer;
  private prices: Record<string, number> = {};

  public preAkiLoad(container: DependencyContainer): void {
    this.container = container;

    container.afterResolution<TradeController>("TradeController", (token: InjectionToken<TradeController>, controller: TradeController) => {
      controller.confirmTrading = (pmcData: IPmcData, body: IProcessBaseTradeRequestData, sessionID: string, foundInRaid?: boolean, upd?: Upd) => {
        return this.confirmTrading(pmcData, body, sessionID, foundInRaid, upd);
      }
    }, {frequency: "Always"})

    this.registerProfileImage();
    this.setupTraderUpdateTime();
  }

  private setupTraderUpdateTime(): void {

    const configServer = this.container.resolve<ConfigServer>("ConfigServer");
    const traderConfig = configServer.getConfig<ITraderConfig>(ConfigTypes.TRADER);
    const traderRefreshConfig: UpdateTime = {traderId: base._id, seconds: 3600}
    traderConfig.updateTime.push(traderRefreshConfig);

  }

  private registerProfileImage(): void {
    const modName = `${author.replace(/[^a-z0-9]/gi, "")}-${name.replace(/[^a-z0-9]/gi, "")}-${version}`;
    const preAkiModLoader = this.container.resolve<PreAkiModLoader>("PreAkiModLoader");
    const imageFilepath = `./${preAkiModLoader.getModPath(modName)}res`;
    const imageRouter = this.container.resolve<ImageRouter>("ImageRouter");
    imageRouter.addRoute(base.avatar.replace(".jpg", ""), `${imageFilepath}/blackmarket.jpg`);
  }

  public postDBLoad(container: DependencyContainer): void {
    this.resolvePrices();

    const databaseServer = this.container.resolve<DatabaseServer>("DatabaseServer");
    const jsonUtil = this.container.resolve<JsonUtil>("JsonUtil");
    const tables = databaseServer.getTables();

    tables.traders[base._id] = {
      assort: {
        items: [], barter_scheme: {}, loyal_level_items: {}, nextResupply: 3600
      },
      base: jsonUtil.deserialize(jsonUtil.serialize(base)) as ITraderBase,
      questassort: {}
    };

    const locales = Object.values(tables.locales.global) as ILocaleGlobalBase[];
    for (const locale of locales) {
      locale.trading[base._id] = {
        FullName: base.name,
        FirstName: "Unknown",
        Nickname: base.nickname,
        Location: base.location,
        Description: "Error 401: Not authorized"
      };
    }

  }

  private confirmTrading(pmcData: IPmcData, body: IProcessBaseTradeRequestData, sessionID: string, foundInRaid: boolean, upd: Upd): IItemEventRouterResponse {
    const tradeHelper = this.container.resolve<TradeHelper>("TradeHelper");

    if (body.type === "buy_from_trader") {
      const buyData = <IProcessBuyTradeRequestData>body;
      return tradeHelper.buyItem(pmcData, buyData, sessionID, foundInRaid, upd);
    }

    if (body.type === "sell_to_trader") {
      const sellData = <IProcessSellTradeRequestData>body;
      if (body.tid === "blackmarket") {
        return this.confirmBlackmarketTrading(pmcData, sellData, sessionID);
      } else {
        return tradeHelper.sellItem(pmcData, sellData, sessionID);
      }
    }

    return null;
  }

  public confirmBlackmarketTrading(pmcData: IPmcData, body: IProcessSellTradeRequestData, sessionID: string): IItemEventRouterResponse {
    const logger = this.container.resolve<ILogger>("WinstonLogger");
    const eventOutputHolder = this.container.resolve<EventOutputHolder>("EventOutputHolder");
    const paymentService = this.container.resolve<PaymentService>("PaymentService");
    const inventoryController = this.container.resolve<InventoryController>("InventoryController");

    this.resolvePrices();

    let output = eventOutputHolder.getOutput(sessionID);
    let money = 0;
    let counter = 0;
    for (const tradeItem of body.items) {
      const checkId = tradeItem.id;
      for (const item of pmcData.Inventory.items) {
        if (item._id == checkId) {
          if (showDebugLog) logger.logWithColor("Blackmarket Trader: Selling item: " + item._tpl, LogTextColor.GREEN);
          if (item.upd == null) {
            if (showDebugLog) logger.logWithColor("Blackmarket Trader: Blackmarket cannot sell item: UDP is null", LogTextColor.RED);
            break;
          }

          if (!item.upd.SpawnedInSession && !disableFIRCondition) {
            if (showDebugLog) logger.logWithColor("Blackmarket Trader: Cannot sell item, item is not found in raid", LogTextColor.YELLOW);
            break;
          }

          const price = this.prices[item._tpl];
          if (price === undefined) {
            if (showDebugLog) logger.logWithColor("Blackmarket Trader: Cannot sell item: Price is not found", LogTextColor.RED);
          } else {
            logger.info("Blackmarket Trader: Sold item: " + item._tpl + " for " + price);
            output = inventoryController.removeItem(pmcData, checkId, sessionID, output);
            money += price;
            counter++;
            break;
          }
        }
      }
    }
    logger.logWithColor("Blackmarket Trader: Sold " + counter + " items", LogTextColor.GREEN)
    return paymentService.getMoney(pmcData, money, body, output, sessionID);
  }

  private resolvePrices() {
    const logger = this.container.resolve<ILogger>("WinstonLogger");
    const databaseServer = this.container.resolve<DatabaseServer>("DatabaseServer");
    const items = databaseServer.getTables().templates.items;
    const ragfairPriceService = this.container.resolve<RagfairPriceService>("RagfairPriceService");

    this.prices = {};

    for (const id in items) {
      const item = items[id];
      const price = ragfairPriceService.getDynamicPriceForItem(id);

      if (price === undefined || (!item._props.CanSellOnRagfair && !disableFleaBlacklist)) {
        if (showDebugLog) logger.logWithColor("Blackmarket Trader: Item cannot be sold on flea market " + id, LogTextColor.RED);
        continue;
      }
      if (showDebugLog) logger.info("Blackmarket Trader: Registering item price for " + item._id + " " + price);
      this.prices[id] = price;
    }
    const pricesCount = Object.keys(this.prices).length;
    const skippedCount = Object.keys(items).length - pricesCount;


    logger.logWithColor("Blackmarket Trader: Registered " + pricesCount + " prices", LogTextColor.GREEN);
    if (showDebugLog) logger.logWithColor("Blackmarket Trader: Could not register prices for " + skippedCount + " items", LogTextColor.RED);

    if (createCSVPriceFile) {
      fs.writeFileSync("BlackmarketItemPrices.csv", this.getCSVPrices());
      logger.info("Blackmarket Trader: Exported item prices into csv file");
    }
  }

  private getCSVPrices(): string {
    const databaseServer = this.container.resolve<DatabaseServer>("DatabaseServer");
    const tables = databaseServer.getTables();
    let csv = "";
    for (const id in this.prices) {
      const price = this.prices[id];
      csv = csv + id + "," + tables.templates.items[id]._name + "," + price + "\n";
    }
    return csv;
  }
}

module.exports = {mod: new BlackmarketTrader()}