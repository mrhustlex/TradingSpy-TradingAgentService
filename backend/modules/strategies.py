import backtrader as bt
import backtrader.indicators as btind

class BaseStrategy(bt.Strategy):
    params = (
        ('printlog', False),
        ('trailpercent', 0.0), # 0.05 = 5% trailing stop
    )

    def log(self, txt, dt=None):
        if self.params.printlog:
            dt = dt or self.datas[0].datetime.date(0)
            print('%s, %s' % (dt.isoformat(), txt))

    def __init__(self):
        self.order = None
        self.stop_price = None

    def notify_order(self, order):
        if order.status in [order.Completed]:
            if order.isbuy():
                if self.p.trailpercent > 0:
                    self.stop_price = order.executed.price * (1.0 - self.p.trailpercent)
            self.bar_executed = len(self)
        self.order = None

    def next(self):
        # Global Trailing Stop Logic
        if self.position and self.p.trailpercent > 0:
            new_stop = self.data.close[0] * (1.0 - self.p.trailpercent)
            if self.stop_price is None or new_stop > self.stop_price:
                self.stop_price = new_stop
            
            if self.data.close[0] < self.stop_price:
                self.log(f"STOP OUT at {self.data.close[0]:.2f} (Stop: {self.stop_price:.2f})")
                self.close()
                self.stop_price = None

class SMA_Cross(BaseStrategy):
    params = (('p1', 50), ('p2', 200),)
    def __init__(self):
        super().__init__()
        self.sma1 = btind.SMA(period=self.p.p1)
        self.sma2 = btind.SMA(period=self.p.p2)
        self.crossover = btind.CrossOver(self.sma1, self.sma2)
    def next(self):
        super().next()
        if not self.position and self.crossover > 0: self.buy()
        elif self.position and self.crossover < 0: self.close()

class EMA_Trend(BaseStrategy):
    params = (('p', 30),)
    def __init__(self):
        super().__init__()
        self.ema = btind.EMA(period=self.p.p)
    def next(self):
        super().next()
        if not self.position and self.data.close[0] > self.ema[0]: self.buy()
        elif self.position and self.data.close[0] < self.ema[0]: self.close()

class MACD_Momentum(BaseStrategy):
    params = (('p1', 12), ('p2', 26), ('psig', 9))
    def __init__(self):
        super().__init__()
        self.macd = btind.MACD(period_me1=self.p.p1, period_me2=self.p.p2, period_signal=self.p.psig)
    def next(self):
        super().next()
        if not self.position and self.macd.macd[0] > self.macd.signal[0]: self.buy()
        elif self.position and self.macd.macd[0] < self.macd.signal[0]: self.close()

class Scalper_EMA_5_13(BaseStrategy):
    params = (('fast', 5), ('slow', 13),)
    def __init__(self):
        super().__init__()
        self.fast_ema = btind.EMA(period=self.p.fast)
        self.slow_ema = btind.EMA(period=self.p.slow)
        self.crossover = btind.CrossOver(self.fast_ema, self.slow_ema)
    def next(self):
        super().next()
        if not self.position and self.crossover > 0: self.buy()
        elif self.position and self.crossover < 0: self.close()

class Short_RSI_Reversion(BaseStrategy):
    params = (('rsi_period', 7), ('oversold', 35), ('exit_level', 55),)
    def __init__(self):
        super().__init__()
        self.rsi = btind.RSI(period=self.p.rsi_period)
    def next(self):
        super().next()
        if not self.position and self.rsi[0] < self.p.oversold: self.buy()
        elif self.position and self.rsi[0] > self.p.exit_level: self.close()

class Swing_SMA_10_30(BaseStrategy):
    params = (('fast', 10), ('slow', 30),)
    def __init__(self):
        super().__init__()
        self.fast_sma = btind.SMA(period=self.p.fast)
        self.slow_sma = btind.SMA(period=self.p.slow)
        self.crossover = btind.CrossOver(self.fast_sma, self.slow_sma)
    def next(self):
        super().next()
        if not self.position and self.crossover > 0: self.buy()
        elif self.position and self.crossover < 0: self.close()

class Swing_MACD_Fast(BaseStrategy):
    params = (('p1', 6), ('p2', 13), ('psig', 5),)
    def __init__(self):
        super().__init__()
        self.macd = btind.MACD(period_me1=self.p.p1, period_me2=self.p.p2, period_signal=self.p.psig)
    def next(self):
        super().next()
        if not self.position and self.macd.macd[0] > self.macd.signal[0]: self.buy()
        elif self.position and self.macd.macd[0] < self.macd.signal[0]: self.close()

class Position_SMA_20_50(BaseStrategy):
    params = (('fast', 20), ('slow', 50),)
    def __init__(self):
        super().__init__()
        self.fast_sma = btind.SMA(period=self.p.fast)
        self.slow_sma = btind.SMA(period=self.p.slow)
        self.crossover = btind.CrossOver(self.fast_sma, self.slow_sma)
    def next(self):
        super().next()
        if not self.position and self.crossover > 0: self.buy()
        elif self.position and self.crossover < 0: self.close()

class BuyAndHold(BaseStrategy):
    def prenext(self):
        self.next()
    
    def nextstart(self):
        self.next()
    
    def next(self):
        if self.order:
            return
        if not self.position:
            self.order = self.buy()
    
    def notify_order(self, order):
        if order.status in [order.Submitted, order.Accepted]:
            self.log(f"Order {order.ref} - Status: {order.getstatusname()}")
        elif order.status in [order.Completed]:
            self.log(f"Order {order.ref} COMPLETED - Price: {order.executed.price:.2f}, Size: {order.executed.size:.2f}")
        elif order.status in [order.Canceled, order.Margin, order.Rejected]:
            self.log(f"Order {order.ref} FAILED - Status: {order.getstatusname()}")
        super().notify_order(order)

# Map strings to classes for the API
STRATEGY_MAP = {
    "SMA_Cross": SMA_Cross,
    "EMA_Trend": EMA_Trend,
    "MACD_Momentum": MACD_Momentum,
    "Scalper_EMA_5_13": Scalper_EMA_5_13,
    "Short_RSI_Reversion": Short_RSI_Reversion,
    "Swing_SMA_10_30": Swing_SMA_10_30,
    "Swing_MACD_Fast": Swing_MACD_Fast,
    "Position_SMA_20_50": Position_SMA_20_50,
    "BuyAndHold": BuyAndHold
}

STRATEGY_CATEGORIES = {
    "SMA_Cross": "Trend Following",
    "EMA_Trend": "Trend Following",
    "MACD_Momentum": "Momentum",
    "Scalper_EMA_5_13": "Short Interval",
    "Short_RSI_Reversion": "Short Interval",
    "Swing_SMA_10_30": "Daily / Swing",
    "Swing_MACD_Fast": "Daily / Swing",
    "Position_SMA_20_50": "Position / Multi-Month",
    "BuyAndHold": "Long Term"
}
