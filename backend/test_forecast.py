import unittest
from forecast import forecast, backtest

class ForecastTests(unittest.TestCase):
    def test_no_leakage(self):
        v=backtest([2]*23+[10]*7)
        self.assertEqual(v['predicted'], [2]*7)
        self.assertEqual(v['mae'],8)
        self.assertEqual(v['wape'],80)
    def test_perfect(self):
        self.assertEqual(backtest([4]*30)['mae'],0)
    def test_zero(self):
        self.assertIsNone(backtest([0]*14)['wape'])
    def test_short(self):
        self.assertIsNone(backtest([1]*13))
    def test_stock_cap(self):
        self.assertEqual(forecast([4]*30,12,10,20,None)['horizons']['7']['revenue'],240)
    def test_expiry(self):
        self.assertEqual(forecast([2]*30,10,5,8,1)['expiry_cost'],30)

if __name__=='__main__': unittest.main()
