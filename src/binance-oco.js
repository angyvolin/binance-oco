const debug = require('debug')('binance-oco');
const Joi = require('joi');
const BigNumber = require('bignumber.js');
const Binance = require('binance-api-node').default;

const schema = Joi.object().keys({
  pair: Joi.string().uppercase().required(),
  amount: Joi.number().positive().required(),
  buyPrice: Joi.number().min(0),
  buyLimitPrice: Joi.number().positive(),
  cancelPrice: Joi.number().positive(),
  stopPrice: Joi.number().positive()
    .when('buyPrice', {
      is: Joi.number().greater(0).required(),
      then: Joi.number().less(Joi.ref('buyPrice')),
    }),
  stopLimitPrice: Joi.number().positive(),
  targetPrice: Joi.number().positive()
    .when('stopPrice', {
      is: Joi.required(),
      then: Joi.number().greater(Joi.ref('stopPrice')),
    })
    .when('buyPrice', {
      is: Joi.required(),
      then: Joi.number().greater(Joi.ref('buyPrice')),
    }),
  scaleOutAmount: Joi.number().less(Joi.ref('amount')).positive(),
  nonBnbFees: Joi.boolean(),
}).or('buyPrice', 'stopPrice', 'targetPrice')
  .with('buyLimitPrice', 'buyPrice')
  .with('cancelPrice', 'buyPrice')
  .with('stopLimitPrice', 'stopPrice')
  .with('scaleOutAmount', 'targetPrice');

const binanceOco = async (options) => {
  const result = Joi.validate(options, schema);
  if (result.error !== null) {
    throw result.error;
  }

  const {
    pair,
    cancelPrice,
    nonBnbFees,
  } = options;

  let {
    amount, buyPrice, buyLimitPrice, stopPrice, stopLimitPrice, targetPrice,
    scaleOutAmount,
  } = options;

  const binance = Binance({
    apiKey: process.env.APIKEY,
    apiSecret: process.env.APISECRET,
  });

  let isCancelling = false;

  const cancelOrderAsync = async (symbol, orderId) => {
    if (!isCancelling) {
      isCancelling = true;
      try {
        const response = await binance.cancelOrder({ symbol, orderId });

        debug('Cancel response: %o', response);
        debug(`order id: ${response.orderId}`);
      } catch (err) {
        debug(`${symbol} cancel error:`, err.body);
      } finally {
        isCancelling = false;
      }
    }
  };

  const placeStopOrderAsync = async (orderAmount) => {
    try {
      const response = await binance.order({
        symbol: pair,
        side: 'SELL',
        quantity: orderAmount,
        price: stopLimitPrice || stopPrice,
        stopPrice,
        type: 'STOP_LOSS_LIMIT',
        newOrderRespType: 'FULL',
      });

      debug('Sell response: %o', response);
      debug(`order id: ${response.orderId}`);

      return response.orderId;
    } catch (err) {
      throw err;
    }
  };

  const placeTargetOrderAsync = async (orderAmount) => {
    try {
      const response = await binance.order({
        symbol: pair,
        side: 'SELL',
        quantity: orderAmount,
        price: targetPrice,
        type: 'LIMIT',
        newOrderRespType: 'FULL',
      });

      debug('Sell response: %o', response);
      debug(`order id: ${response.orderId}`);

      return response.orderId;
    } catch (err) {
      throw err;
    }
  };

  const isOrderFilled = (data) => {
    const {
      symbol, priceLastTrade, lastTradeQuantity, totalTradeQuantity, side,
      orderType, orderId, orderStatus,
    } = data;

    debug(`${symbol} ${side} ${orderType} ORDER #${orderId} (${orderStatus})`);
    debug(`..last price: ${priceLastTrade}, last trade quantity: ${lastTradeQuantity}, total trade quantity: ${totalTradeQuantity}`);

    if (orderStatus === 'NEW' || orderStatus === 'PARTIALLY_FILLED') {
      return false;
    }

    if (orderStatus !== 'FILLED') {
      throw new Error(`Order ${orderStatus}. Reason: ${data.orderRejectReason}`);
    }

    return true;
  };

  let disconnect;
  let stopSellAmount;
  let targetSellAmount;

  const waitForSellOrderFill = sellOrderId => new Promise((resolve, reject) => {
    let stopOrderId = sellOrderId;
    let targetOrderId = 0;

    try {
      disconnect = binance.ws.trades(pair, async (trade) => {
        try {
          const { symbol, price } = trade;
          debug(`${symbol} trade update. price: ${price} stop: ${stopPrice} target: ${targetPrice}`);
          if (stopOrderId && !targetOrderId && BigNumber(price).gte(targetPrice) && !isCancelling) {
            await cancelOrderAsync(symbol, stopOrderId);
            stopOrderId = 0;
            targetOrderId = await placeTargetOrderAsync(targetSellAmount);
          } else if (targetOrderId && !stopOrderId
            && BigNumber(price).lte(stopPrice) && !isCancelling) {
            await cancelOrderAsync(symbol, targetOrderId);
            targetOrderId = 0;
            stopOrderId = await placeStopOrderAsync(stopSellAmount);
          }
        } catch (err) {
          reject(err);
        }
      });

      binance.ws.user((msg) => {
        try {
          if (msg.eventType !== 'executionReport') return;
          const { orderId } = msg;
          if (orderId === stopOrderId || orderId === targetOrderId) {
            if (isOrderFilled(msg)) {
              resolve();
            }
          }
        } catch (err) {
          reject(err);
        }
      });

      binance.getOrder({
        symbol: pair,
        orderId: sellOrderId,
      }).then((response) => {
        if (response.status === 'FILLED') {
          resolve();
        }
      });
    } catch (err) {
      reject(err);
    }
  });

  let isLimitEntry = false;
  let isStopEntry = false;

  const waitForBuyOrderFill = buyOrderId => new Promise((resolve, reject) => {
    try {
      disconnect = binance.ws.trades(pair, async (trade) => {
        try {
          const { symbol, price } = trade;
          if (!cancelPrice) {
            debug(`${symbol} trade update. price: ${price} buy: ${buyPrice}`);
          } else {
            debug(`${symbol} trade update. price: ${price} buy: ${buyPrice} cancel: ${cancelPrice}`);

            if (((isStopEntry && BigNumber(price).lte(cancelPrice))
              || (isLimitEntry && BigNumber(price).gte(cancelPrice)))
              && !isCancelling) {
              await cancelOrderAsync(symbol, buyOrderId);
              reject(new Error(`Order CANCELED. Reason: cancel price ${cancelPrice} hit`));
            }
          }
        } catch (err) {
          reject(err);
        }
      });

      binance.ws.user((msg) => {
        try {
          if (msg.eventType !== 'executionReport') return;
          const { orderId } = msg;
          if (orderId === buyOrderId && isOrderFilled(msg)) {
            resolve(msg.commissionAsset);
          }
        } catch (err) {
          reject(err);
        }
      });

      binance.getOrder({
        symbol: pair,
        orderId: buyOrderId,
      }).then((response) => {
        if (response.status === 'FILLED') {
          // Binance API doesn't provide commission asset information; default to BNB
          resolve('BNB');
        }
      });
    } catch (err) {
      reject(err);
    }
  });

  const round = (toBeRounded, toNearest) => {
    const fractionDigits = Math.max(toNearest.indexOf('1') - 1, 0);
    return BigNumber(toBeRounded).toFixed(fractionDigits, BigNumber.ROUND_DOWN);
  };

  const adjustSellAmountsForCommission = async (commissionAsset, stepSize) => {
    if (commissionAsset !== 'BNB' || nonBnbFees) {
      try {
        const tradeFee = (await binance.tradeFee()).tradeFee.find(ei => ei.symbol === pair);
        if (tradeFee) {
          stopSellAmount = round(BigNumber(stopSellAmount).times(1 - tradeFee.maker), stepSize);
          targetSellAmount = round(BigNumber(targetSellAmount).times(1 - tradeFee.maker), stepSize);
        }
      } catch (err) {
        debug(`Could not pull trade fee for ${pair}: ${err.body}`);
        throw err;
      }
    }
  };

  const symbolData = (await binance.exchangeInfo()).symbols.find(ei => ei.symbol === pair);
  if (!symbolData) {
    throw new Error(`Could not pull exchange info for ${pair}`);
  }

  const { filters } = symbolData;
  const { stepSize } = filters.find(eis => eis.filterType === 'LOT_SIZE');
  const { tickSize, minPrice } = filters.find(eis => eis.filterType === 'PRICE_FILTER');
  const { minNotional } = filters.find(eis => eis.filterType === 'MIN_NOTIONAL');

  amount = round(amount, stepSize);

  if (scaleOutAmount) {
    scaleOutAmount = round(scaleOutAmount, stepSize);
  }

  stopSellAmount = amount;
  targetSellAmount = scaleOutAmount || amount;

  if (buyPrice) {
    buyPrice = round(buyPrice, tickSize);

    if (buyLimitPrice) {
      buyLimitPrice = round(buyLimitPrice, tickSize);
    } else {
      const accountInfo = await binance.accountInfo();
      const { quoteAsset } = symbolData;
      const available = accountInfo.balances.find(ab => ab.asset === quoteAsset).free;
      const maxAvailablePrice = BigNumber(available).div(amount);

      const currentPrice = (await binance.avgPrice({ symbol: pair })).price;
      const { multiplierUp } = filters.find(eis => eis.filterType === 'PERCENT_PRICE');
      const maxPercentPrice = BigNumber(currentPrice).times(multiplierUp);

      buyLimitPrice = round(BigNumber.min(maxAvailablePrice, maxPercentPrice)
        .minus(tickSize), tickSize);
    }
  }

  if (stopPrice) {
    stopPrice = round(stopPrice, tickSize);

    const minStopSellAmount = BigNumber(stopSellAmount).minus(targetSellAmount).isZero()
      ? stopSellAmount
      : round(BigNumber.min(targetSellAmount, BigNumber(stopSellAmount).minus(targetSellAmount)),
        stepSize);

    if (stopLimitPrice) {
      stopLimitPrice = round(stopLimitPrice, tickSize);
    } else {
      const currentPrice = (await binance.avgPrice({ symbol: pair })).price;
      const { multiplierDown } = filters.find(eis => eis.filterType === 'PERCENT_PRICE');
      const minPercentPrice = BigNumber(currentPrice).times(multiplierDown);
      const minNotionalPrice = BigNumber(minNotional).div(minStopSellAmount);

      stopLimitPrice = round(BigNumber.max(minPrice, minPercentPrice, minNotionalPrice)
        .plus(tickSize), tickSize);
    }

    if (buyPrice || targetPrice) {
      const order = {
        symbol: pair,
        side: 'SELL',
        quantity: minStopSellAmount,
        price: stopLimitPrice,
        stopPrice,
        type: 'STOP_LOSS_LIMIT',
      };
      debug('Validating stop order: %o', order);
      await binance.orderTest(order);
      debug('Stop order valid');
    }
  }

  if (targetPrice) {
    targetPrice = round(targetPrice, tickSize);
    if (buyPrice || stopPrice) {
      const order = {
        symbol: pair,
        side: 'SELL',
        quantity: targetSellAmount,
        price: targetPrice,
        type: 'LIMIT',
      };
      debug('Validating target order: %o', order);
      await binance.orderTest(order);
      debug('Target order valid');
    }
  }

  if (BigNumber(buyPrice).gte(0)) {
    let response;
    try {
      if (BigNumber(buyPrice).isZero()) {
        response = await binance.order({
          symbol: pair,
          side: 'BUY',
          quantity: amount,
          type: 'MARKET',
          newOrderRespType: 'FULL',
        });
      } else if (BigNumber(buyPrice).gt(0)) {
        const prices = await binance.prices();
        const currentPrice = prices[pair];
        debug(`${pair} price: ${currentPrice}`);

        if (BigNumber(buyPrice).gt(currentPrice)) {
          isStopEntry = true;
          response = await binance.order({
            symbol: pair,
            side: 'BUY',
            quantity: amount,
            price: buyLimitPrice || buyPrice,
            stopPrice: buyPrice,
            type: 'STOP_LOSS_LIMIT',
            newOrderRespType: 'FULL',
          });
        } else {
          isLimitEntry = true;
          response = await binance.order({
            symbol: pair,
            side: 'BUY',
            quantity: amount,
            price: buyPrice,
            type: 'LIMIT',
            newOrderRespType: 'FULL',
          });
        }
      }
    } catch (err) {
      throw err;
    }

    debug('Buy response: %o', response);
    debug(`order id: ${response.orderId}`);

    let commissionAsset;
    if (response.status !== 'FILLED') {
      commissionAsset = await waitForBuyOrderFill(response.orderId).finally(disconnect);
    } else if (response.fills && response.fills.length > 0) {
      // eslint-disable-next-line prefer-destructuring
      commissionAsset = response.fills[0].commissionAsset;
    }

    if (stopPrice || targetPrice) {
      await adjustSellAmountsForCommission(commissionAsset, stepSize);
    }
  }

  if (stopPrice && targetPrice) {
    if (BigNumber(targetSellAmount).lt(stopSellAmount)) {
      await placeStopOrderAsync(round(BigNumber(stopSellAmount)
        .minus(targetSellAmount), stepSize));
      stopSellAmount = targetSellAmount;
    }

    const stopOrderId = await placeStopOrderAsync(stopSellAmount);
    await waitForSellOrderFill(stopOrderId).finally(disconnect);
  } else if (stopPrice && !targetPrice) {
    await placeStopOrderAsync(stopSellAmount);
  } else if (!stopPrice && targetPrice) {
    await placeTargetOrderAsync(targetSellAmount);
  }
};

module.exports = { binanceOco };